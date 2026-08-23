/**
 * QwenAdapterLive — qwen CLI (`CLI --acp`) via ACP.
 *
 * ru-code: ported from the t3 CliAdapter. Modelled closely after
 * CursorAdapter: spawns an ACP child process, maps session update events into
 * canonical T3 runtime events, and supports permission-request / user-input
 * flows through deferred resolution.
 *
 * @module QwenAdapterLive
 */
import {
  CLI_ERROR_TASK_PREFIX,
  CLI_ERROR_TASK_TYPE,
  CONTEXT_COMPACTION_TASK_PREFIX,
  CONTEXT_COMPACTION_TASK_TYPE,
  QWEN_KIND,
} from "@ru-code/branding";
import {
  ApprovalRequestId,
  defaultInstanceIdForDriver,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type QwenSettings,
  type RuntimeMode,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskStatus, // ru-code (sub-agents): the row's waiting marker
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type AbortMethod,
  ACP_CANCEL_GRACE_MS,
  ACP_SESSION_START_TIMEOUT_MS,
  ACP_WARM_ENGINE,
  AUTO_COMPACT_DISARM_FRACTION,
  COMPACT_MIN_GAIN_PRE_FRACTION,
  COMPACTION_RESTART_METHOD,
  AUTO_COMPACT_USED_FRACTION,
  MAINTENANCE_METHOD,
  MCP_ENGINE_USE_OVERLAY,
  MODE_CHANGE_METHOD,
  QWEN_MODELS_AUTO_DISCOVERY,
  STOP_BUTTON_METHOD,
  MCP_PREWARM_INSTANCES,
  MCP_PREWARM_MAX_PROJECTS,
  PREWARM_GENERIC_INSTANCES,
  WARM_REFILL_BREAKER_FAILS,
  WARM_SLOT_MAX_AGE_ENABLED,
  WARM_SLOT_MAX_AGE_MS,
  WARM_SLOT_WARMUP_TIMEOUT_MS,
} from "@ru-code/qwen/constants";
import { settleAndDelete, type AcpPendingKind } from "@ru-code/qwen/acp/QwenAcpPendingRequests";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import {
  decisionToPermissionKind,
  findPermissionOptionIdByKind,
  mapAcpToAdapterError,
} from "./acp/QwenAcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "./acp/QwenAcpSessionRuntime.ts";
// ru-code: qwen sub-agent attribution — reads the `_meta` qwen stamps on every
// sub-agent frame and turns it into the canonical agent surface. See the module
// header for why nothing in provider/acp/ needs to change.
import {
  appendQwenAgentText,
  classifyQwenToolCallFrame,
  formatQwenAgentPlanLine,
  formatQwenAgentToolLine,
  formatQwenAgentWaitingLine,
  isQwenSubAgentFrame,
  openQwenAgentWindow,
  QWEN_SUBAGENT_TASK_TYPE,
  type QwenAgentWindow,
  takeQwenAgentLine,
  withQwenAgentAttribution,
} from "./acp/QwenAcpSubAgents.ts";
// ru-code (warm engine): the warm CLI process pool — take at startSession,
// refill after a successful bind (acp-process-pool §2.3). Extracted to the
// external package (generic over the slot runtime; host supplies the spawn).
import {
  makeWarmAcpPool,
  type TakenWarmSlot,
  type WarmKeyInput,
  type WarmTakeRequest,
} from "@smart-tools/acp-warm-pool/server";
// ru-code (warm engine): write-only pid journal for a future leftover-cleanup
// feature (acp-process-pool §2.5) — record on spawn, remove on teardown.
import { makeQwenProcessJournal } from "./lifecycle/QwenProcessJournal.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../../provider/acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../../provider/acp/AcpRuntimeModel.ts";
import { makeQwenAcpRuntime } from "./QwenAcpSupport.ts";
// ru-code: resolve the instance's effective bin/name/artifact (profile + settings + preflight)
// and the per-model auth method + wire format appended at setModel.
import { formatQwenModelId, resolveCliProfileSettings } from "./profileResolver.ts";
import { resolveServedModelAuthMethod, serveQwenModels } from "./discovery/serveQwenModels.ts";
import {
  attributeItemCompleted,
  attributeItemDelta,
  attributeItemStarted,
  type ItemTurnAttributionState,
} from "./itemTurnAttribution.ts";
import { type ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
// ru-code: subagent picker biases CLI toward the Agent tool by
// injecting a system-reminder when the user text contains `agent:name`.
// ru-code: strips the delimited chip fences (`skill:⟦name⟧` → `skill:name`) AND injects the right
// system-reminder (single skill/agent, or a CHAIN reminder for 2+ chips) in one step.
import { buildComposerReminder } from "@smart-tools/qwen-cli-skill-manager/contracts";
// ru-code: classifier for cli-side errors — routes recognized
// failures to the right UI surface.
import {
  classify,
  COMPRESS_IN_PROGRESS_DETAIL,
  readAcpDetails,
  UNRECOGNIZED_DECISION,
} from "./errors/recognizers.ts";
import { Surface, hasSurface } from "@ru-code/qwen/errors/types";
import { cliErrorFields } from "@ru-code/qwen/errors/dispatch";
// ru-code: live model discovery — channel A (session-start advertisement) and
// channel B (model-error corrections) write into the per-instance store.
import type { QwenModelDiscoveryStoreShape } from "./discovery/QwenModelDiscoveryStore.ts";
// ru-code: history-derived circuit breaker for auto-compaction (restart-proof).
import {
  isAutoCompactDisarmed,
  type QwenThreadCompactionState,
} from "./compaction/compactionHistory.ts";
import { discoveredModelsFromSessionSetup } from "./discovery/discoveredModelsFromSessionSetup.ts";
import { detectModelErrorDiscovery } from "./discovery/modelErrorDiscovery.ts";
import { resolveQwenModelContextWindow } from "./discovery/resolveQwenModelContextWindow.ts";
import {
  describeRequestFailure,
  describeRequestPayload,
} from "@ru-code/qwen/errors/requestLogFormat";
// ru-code: live token feed — pull qwen's running promptTokenCount off each
// agent_message_chunk's _meta so the context meter updates mid-turn.
import { extractQwenInputTokens } from "./usage.ts";
import { triggerGenericPrewarm } from "./warmPrewarmTrigger.ts";

const PROVIDER = ProviderDriverKind.make(QWEN_KIND);

// Expandable body of the "compression didn't help" rows (gate trip and
// ineffective-below-gate): why it happens and what actually helps.
const COMPACTION_ADVICE_DETAIL =
  "Compacting an already-compacted or short conversation is ineffective — the CLI needs new messages for compaction to help. Continue the conversation, pick a model with a larger context, or start a new conversation.";

// ru-code: a classifiable session-start failure (notably B3 — an `AcpSpawnError`
// wrapped in `ProviderAdapterProcessError`) surfaces PRE-TURN, so the reactor
// handles it via its generic start-failure path where `formatFailureDetail` would
// otherwise fall back to a raw `Cause.pretty` dump for anything that is not a
// `ProviderAdapterRequestError`. Remap such a failure to a
// `ProviderAdapterRequestError` whose `.detail` is the classifier's user-facing
// text so the reactor shows the classified banner (and, via its seam, the classified
// timeline summary). The original adapter error is preserved as `.cause` (the
// classifier still recovers the inner `AcpSpawnError` from it). Non-classifiable /
// silent failures pass through unchanged, keeping today's behaviour.
const remapStartFailureThroughClassifier = (
  method: string,
  error: ProviderAdapterError,
): ProviderAdapterError => {
  const decision = classify(error, Cause.fail(error));
  if (decision !== null && decision.surface !== undefined) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: decision.text,
      cause: error,
    });
  }
  return error;
};

type QwenAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface QwenAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /**
   * ru-code: override the ACP start-handshake timeout. Production omits it ⇒
   * ACP_SESSION_START_TIMEOUT_MS. Tests pass a tiny value so a scripted hang at
   * `session/new` trips the timeout without a real-time wait.
   */
  readonly sessionStartTimeoutMs?: number;
  /**
   * ru-code: sink for live model discovery. When present, the adapter persists
   * the session-start model advertisement (channel A, wholesale replace) and
   * model-not-found corrections (channel B, remove-bad + add-suggested) for
   * this instance. Absent in tests that don't exercise discovery.
   */
  readonly modelDiscoveryStore?: QwenModelDiscoveryStoreShape;
  /**
   * ru-code: live reader of the `autoCompactContext` server setting. When it
   * yields true and a turn ends with the context ≥ AUTO_COMPACT_USED_FRACTION
   * full, the adapter runs a hidden `/compress`. Absent ⇒ auto-compact off
   * (tests, minimal harnesses).
   */
  readonly getAutoCompactContext?: Effect.Effect<boolean>;
  /**
   * ru-code: reader of the thread's persisted compaction history — feeds the
   * auto-compact circuit breaker (derived from history, so it survives server
   * restarts). Absent ⇒ breaker armed (tests, minimal harnesses).
   */
  readonly getThreadCompactionState?: (
    threadId: ThreadId,
  ) => Effect.Effect<QwenThreadCompactionState>;
  /**
   * ru-code: warm-engine gate override. Production omits it ⇒ ACP_WARM_ENGINE.
   * Tests pass an explicit value to pin either the warm or the classic path
   * without flipping the repo constant.
   */
  readonly warmEngine?: boolean;
  /**
   * ru-code: grace between `session/cancel` and the background SIGKILL on a
   * stop with an in-flight prompt. Production omits it ⇒ ACP_CANCEL_GRACE_MS.
   * Tests pass a tiny value so the grace path settles without a real wait.
   */
  readonly cancelGraceMs?: number;
  /**
   * ru-code: boot prewarm override. Default: only the first/default qwen
   * instance prewarms the generic pool at adapter start; other instances pool
   * lazily on first use. Tests pin either behavior explicitly.
   */
  readonly prewarmOnCreate?: boolean;
  /**
   * ru-code: warm-pool sizing/behavior overrides for tests (production omits
   * ⇒ the constants). See ru-code/qwen/constants.ts for semantics.
   */
  readonly poolOptions?: {
    readonly genericTarget?: number;
    readonly mcpTarget?: number;
    readonly mcpMaxProjects?: number;
    readonly breakerFails?: number;
    readonly maxAgeEnabled?: boolean;
    readonly maxAgeMs?: number;
    readonly warmupTimeoutMs?: number;
  };
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  // Index lookup for converting our id-keyed answers back to Cli's
  // index-keyed wire shape ({"0":"Fruity"} etc.). Populated when the
  // request is intercepted, consumed when the user submits answers.
  readonly questionIndexById: ReadonlyMap<string, number>;
}

interface QwenSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  childExitFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  // ru-code: turn identity per assistant item. The ACP runtime enqueues the
  // trailing AssistantItemCompleted AFTER session/prompt resolves, and the
  // notification fiber may consume it after the finalizer already cleared
  // `activeTurnId` — stamping from `activeTurnId` there wipes the message's
  // turnId in every projection (diff chip / revert / healing all go blind).
  // The turn an item belongs to is fixed the moment the item STARTS, so it is
  // recorded here at AssistantItemStarted and read back at completion.
  readonly itemTurnIds: Map<string, TurnId>;
  // ru-code: the most recent turn dispatched on this session — unlike
  // `activeTurnId` it survives the finalizer. Fallback attribution for an
  // item that STARTS after the turn settled (qwen emits chunks without
  // awaiting them — see Session.ts:308 in qwen-code — so a late delta can
  // trail the prompt response): such an item belongs to the turn that just
  // ended, never to "no turn".
  lastTurnId: TurnId | undefined;
  // ru-code: resolved by sendTurn's finalizer the instant it offers the
  // turn's single `turn.completed`. `abortSession` awaits this (when a turn
  // is active) before offering `session.exited`, so `turn.completed` is
  // always ingested first (I5: ingestion strips the per-turn assistant cache
  // on `session.exited`; finalizing the message after that strip would leave
  // the bubble timer stuck forever). Replaced per turn in `sendTurn`.
  turnFinalized: Deferred.Deferred<void> | undefined;
  // ru-code: set true by the cancel-INTENT teardown sites (the Stop button
  // via `interruptTurn`, and the mode-change teardown in `startSession`)
  // BEFORE the force-kill. The finalizer reads it to label the turn
  // `cancelled` (not a transport `failed`) — deterministic because it is set
  // before the kill that fails the in-flight prompt. Other teardowns
  // (maintenance/child-exit) leave it false so the turn keeps its
  // real failure label. Reset to false at the start of each `sendTurn`.
  userCancelRequested: boolean;
  stopped: boolean;
  // ru-code (warm engine): the in-flight `session/prompt` RPC, forked by
  // sendTurn so the instant-settle stop can interrupt exactly the prompt —
  // the turn then settles cancelled at ~0ms while the process dies in a
  // detached background teardown. undefined outside the prompt window (the
  // stop falls back to the classic inline-kill path there).
  activePromptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, ProviderAdapterError> | undefined;
  // ru-code (warm engine): set by the child-exit watcher BEFORE it schedules
  // the teardown. A crash-driven teardown must NOT take the instant-settle
  // path — interrupting the prompt fiber there could beat the transport
  // failure and mislabel the crash `cancelled` instead of its classified
  // error (B1.<code>). With the flag, the classic path runs and the turn
  // settles through the classifier exactly as today.
  childExitObserved: boolean;
  // ru-code: live runtimeMode mirror. Refreshed by sendTurn and
  // respondToRequest from their per-call inputs. Read by the cli-initiated
  // requestPermission callback (plan-approval optionId and full-access
  // short-circuit) which has no per-call input of its own.
  currentRuntimeMode: RuntimeMode;
  // ru-code: dedupe cursor for the live token feed — the last usedTokens value
  // emitted as `thread.token-usage.updated`. Shared by the ContentDelta feed and
  // the /compress emit so a repeat value never re-fires the meter update.
  lastEmittedUsedTokens?: number;
  // ru-code: clean slug of the model the last sendTurn dispatched — the meter
  // denominator (`resolveQwenModelContextWindow`) is per-model, and the usage
  // emit sites run on the notification fiber with no per-call input.
  currentModelSlug?: string;
  // ru-code: true while a HIDDEN `/compress` prompt (compactContext) is in
  // flight. The slash-notification handler then suppresses the bubble deltas
  // and stashes the outcome here instead; compactContext reads it after the
  // prompt settles to emit the timeline row / fail the call.
  hiddenCompressActive?: boolean;
  // ru-code (sub-agents): the ONE root-agent window that can be open at a time
  // (qwen awaits each `agent` tool call before starting the next —
  // qwen-code Session.ts:353-359/:881). While it is set, every UNSTAMPED frame
  // belongs to that child: text goes to the row's live line instead of the chat,
  // the child's plan is parked on the row instead of replacing the parent's, and
  // a permission prompt marks the row as waiting. Opened by AgentRootStarted,
  // cleared by AgentRootSettled; a session that dies mid-window is swept by the
  // client's sessionLive:false pass (subagentRuntime.ts:650-661).
  subAgentWindow?: QwenAgentWindow | undefined;
  hiddenCompressOutcome?:
    | { readonly kind: "success"; readonly preTokens: number; readonly postTokens: number }
    | { readonly kind: "error"; readonly message: string }
    | undefined;
}

// ru-code: live view of the session fields the item-turn attribution reads
// (itemTurnAttribution.ts owns the decision; the ctx fields are mutable so the
// state must be sampled per event, not captured once).
function itemAttributionState(ctx: QwenSessionContext): ItemTurnAttributionState {
  return {
    activeTurnId: ctx.activeTurnId,
    lastTurnId: ctx.lastTurnId,
    hiddenCompressActive: ctx.hiddenCompressActive === true,
  };
}

// ru-code: opaque read of the hidden-compress outcome. compactContext writes
// `undefined` into the field before/after the prompt while the notification
// fiber sets the real value mid-prompt — a direct property read would carry
// TS's stale `undefined` narrowing; the call boundary resets it.
function readHiddenCompressOutcome(
  ctx: QwenSessionContext,
): QwenSessionContext["hiddenCompressOutcome"] {
  return ctx.hiddenCompressOutcome;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

// Cli smuggles two distinct flows through the standard `session/request_permission`
// channel — distinguished only by the embedded tool name + rawInput shape:
//
//  - `ask_user_question` → `rawInput.questions: Question[]`
//  - `exit_plan_mode`    → `rawInput.plan: string` (markdown)
//
// Anything else (file edits, shell commands) is a normal approval prompt.

interface QwenAskQuestionRaw {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly multiSelect?: boolean;
}

interface QwenAskQuestionsPayload {
  readonly questions: ReadonlyArray<QwenAskQuestionRaw>;
}

interface QwenExitPlanPayload {
  readonly plan: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ru-code: empty-stream and other RPC recognizers live in
// `./errors/recognizers.ts`.
// The catch at `session/prompt` below calls `classify(...)` to look
// them up. Keeping `isAcpProcessExitedError` here because the tapError
// logs at the two `mapAcpToAdapterError` call sites need it before the
// classifier runs (the log captures the exit code at the boundary).
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
function readToolName(params: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  const meta = params.toolCall._meta;
  if (!isRecord(meta)) return undefined;
  const toolName = meta["toolName"];
  return typeof toolName === "string" ? toolName : undefined;
}

function readAskQuestionsPayload(
  params: EffectAcpSchema.RequestPermissionRequest,
): QwenAskQuestionsPayload | undefined {
  const rawInput = params.toolCall.rawInput;
  if (!isRecord(rawInput)) return undefined;
  const questions = rawInput["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  for (const entry of questions) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry["question"] !== "string") return undefined;
    if (typeof entry["header"] !== "string") return undefined;
    if (!Array.isArray(entry["options"])) return undefined;
  }
  return { questions: questions as ReadonlyArray<QwenAskQuestionRaw> };
}

// Detection only — used by the diagnostic log so we can tell whether a
// generic-approval permission request was actually `exit_plan_mode` carrying
// a plan markdown. No early-return / no special handling: the request still
// flows through the generic approval path so the user gets Cli's native
// proceed/cancel dialog.
// ru-code: exported for direct unit coverage (plan-markdown parse from the held request).
export function readExitPlanPayload(
  params: EffectAcpSchema.RequestPermissionRequest,
): QwenExitPlanPayload | undefined {
  const rawInput = params.toolCall.rawInput;
  if (!isRecord(rawInput)) return undefined;
  const plan = rawInput["plan"];
  if (typeof plan !== "string" || plan.trim().length === 0) return undefined;
  return { plan: plan.trim() };
}

function slugifyHeader(header: string): string {
  const normalized = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "q";
}

function qwenQuestionId(index: number, header: string): string {
  return `cli-q${index}-${slugifyHeader(header)}`;
}

interface NormalizedQwenQuestions {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly questionIndexById: ReadonlyMap<string, number>;
}

function normalizeQwenQuestions(payload: QwenAskQuestionsPayload): NormalizedQwenQuestions {
  const questionIndexById = new Map<string, number>();
  const questions = payload.questions.map((entry, index) => {
    const id = qwenQuestionId(index, entry.header);
    questionIndexById.set(id, index);
    const options = entry.options.map((option) => ({
      label: option.label,
      // Cli's question options always supply a label; description is
      // optional in the wire payload but required by our schema. Fall back
      // to the label so the dialog still renders.
      description:
        typeof option.description === "string" && option.description.trim().length > 0
          ? option.description
          : option.label,
    }));
    const result: UserInputQuestion = {
      id,
      header: entry.header,
      question: entry.question,
      options,
      multiSelect: entry.multiSelect === true,
    };
    return result;
  });
  return { questions, questionIndexById };
}

// ProviderUserInputAnswers values are `unknown` because adapters historically
// pass arbitrary shapes. For Cli the wire format is a flat
// `Record<stringIndex, string>`, so we coerce common shapes (string | string[])
// into one comma-joined string per question and drop unknown shapes silently.
function encodeQwenAnswersForPermission(
  answers: ProviderUserInputAnswers,
  questionIndexById: ReadonlyMap<string, number>,
): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [questionId, rawValue] of Object.entries(answers)) {
    const index = questionIndexById.get(questionId);
    if (index === undefined) continue;
    const stringValue = (() => {
      if (typeof rawValue === "string") return rawValue;
      if (Array.isArray(rawValue)) {
        return rawValue
          .filter(
            (entry): entry is string | number | boolean => entry !== null && entry !== undefined,
          )
          .map((entry) => String(entry))
          .join(", ");
      }
      if (rawValue === null || rawValue === undefined) return "";
      return String(rawValue);
    })();
    if (stringValue.length === 0) continue;
    encoded[String(index)] = stringValue;
  }
  return encoded;
}

function selectQwenSubmitOptionId(params: EffectAcpSchema.RequestPermissionRequest): string {
  const allowOnce = params.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnce?.optionId === "string" && allowOnce.optionId.trim().length > 0) {
    return allowOnce.optionId.trim();
  }
  // Fallback to the literal Cli exposes in 0.15.5; safe even if the option
  // list shape changes upstream because we just send the string Cli expects.
  return "proceed_once";
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

// ru-code: maps the two composer dropdowns onto cli-code's ApprovalMode
// enum (cli-code/packages/core/src/config/config.ts:148-191). `plan` wins
// over runtimeMode so the runtimeMode value is preserved in ru-code state
// and re-applies when the user leaves plan. full-access maps to "auto-edit"
// (not "yolo") because yolo bypasses CLI's L4 PermissionManager rules
// (Session.ts:651-656); anything still ask-default under auto-edit is caught
// by the server-side short-circuit in the requestPermission handler.
type QwenWireMode = "plan" | "default" | "auto-edit";

// ru-code: exported for direct unit coverage (mode → CLI ApprovalMode mapping).
export function resolveQwenMode(input: {
  readonly interactionMode: "plan" | "default" | undefined;
  readonly runtimeMode: RuntimeMode;
}): QwenWireMode {
  if (input.interactionMode === "plan") return "plan";
  if (input.runtimeMode === "auto-accept-edits") return "auto-edit";
  if (input.runtimeMode === "full-access") return "auto-edit";
  return "default";
}

const QWEN_RESUME_VERSION = 1 as const;

interface QwenResumeCursor {
  readonly schemaVersion: typeof QWEN_RESUME_VERSION;
  readonly sessionId: string;
}

// ru-code: exported for direct unit coverage (resume-cursor decode / back-compat gate).
export function parseQwenResume(raw: unknown): { sessionId: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<QwenResumeCursor>;
  if (candidate.schemaVersion !== QWEN_RESUME_VERSION) return undefined;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()) return undefined;
  return { sessionId: candidate.sessionId.trim() };
}

export function makeQwenAdapter(qwenSettings: QwenSettings, options?: QwenAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(QWEN_KIND);
    // ru-code: bound the start handshake so a wedged `cli --acp` boot fails instead
    // of hanging the turn forever (and, for MCP, promptly releases the ephemeral overlay).
    const sessionStartTimeoutMs = options?.sessionStartTimeoutMs ?? ACP_SESSION_START_TIMEOUT_MS;
    // ru-code: warm-engine gate + stop grace (see ru-code/qwen/constants.ts).
    const warmEngine = options?.warmEngine ?? ACP_WARM_ENGINE;
    const cancelGraceMs = options?.cancelGraceMs ?? ACP_CANCEL_GRACE_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // ru-code: resolve profile → bin (cli.js/command to spawn) + name + artifact.
    // Settings override the profile default; a null default falls back to preflight.
    const resolved = resolveCliProfileSettings(qwenSettings, {
      cliJs: serverConfig.cliJs,
      cliConfigDir: serverConfig.cliConfigDir,
    });
    const crypto = yield* Crypto.Crypto;
    // ru-code: secure UUID source. A missing CSPRNG is unrecoverable for an adapter
    // that must mint event/request/turn ids, so we die rather than thread PlatformError
    // through every id call site.
    const cryptoUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const nativeEventLogger = options?.nativeEventLogger ?? undefined;

    const sessions = new Map<ThreadId, QwenSessionContext>();
    // ru-code (warm engine): per-thread teardown latches. An instant-settle
    // stop resolves client-side immediately and parks the dying process's
    // cancel→grace→SIGKILL in a background fiber; the latch marks that window.
    // Only an immediate SAME-thread re-send awaits it (the old process must
    // stop appending to the session JSONL before `session/load` re-reads it).
    const teardownLatches = new Map<ThreadId, Deferred.Deferred<void>>();
    // ru-code (warm engine): set at the adapter finalizer's entry. A detached
    // teardown forked onto a CLOSING layer scope would be interrupted before
    // it ever evaluates (kill/latch tail silently dropped) — teardowns check
    // this and finish inline instead.
    let adapterClosing = false;
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // ru-code: the adapter-layer scope. Session-bound fibers (child-exit
    // watcher) fork their teardown onto THIS scope via `scheduleTeardown` so
    // `abortSession` runs on a fresh fiber — never the watcher's own fiber.
    // Running it inline there would self-interrupt (`abortSession` interrupts
    // those very fibers), aborting the teardown before it offers
    // `session.exited`.
    const layerScope = yield* Effect.scope;

    // ru-code (warm engine): the warm process pool + its slot-overlay dir.
    // One pool per adapter instance (instances never mix, I-3); pool scope ⊂
    // adapter layer scope so instance rebuild / shutdown drains it (I-7). The
    // dir sweep clears slot-overlay copies a hard crash left behind (mirrors
    // the canonical overlay boot sweep). Warm slots spawn through the SAME
    // factory + spawn-input builder as cold sessions — the recipe cannot
    // drift; only the neutral spawn cwd and the slot overlay path differ, the
    // real cwd/resume cursor arrive at bind (G2/G8).
    // ru-code (warm engine): BOTH per-stateDir artifacts are keyed by the
    // instance — multiple configured qwen instances (brand profiles) each get
    // their own journal file and warm dir, so one instance's flushes/wipes can
    // never clobber another's entries or in-flight overlay copies.
    const instanceSlug = String(boundInstanceId).replace(/[^A-Za-z0-9._-]/g, "_");
    const warmDir = path.join(serverConfig.stateDir, "qwen-warm", instanceSlug);
    // ru-code (warm engine): write-only, best-effort pid journal (I-12) — a
    // future leftover-cleanup feature's data source; nothing reads it here.
    const processJournal = warmEngine
      ? yield* makeQwenProcessJournal({
          journalPath: path.join(serverConfig.stateDir, `qwen-pids.${instanceSlug}.json`),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )
      : undefined;
    // ru-code (warm engine): one slot runtime — the SAME factory + spawn-input
    // builder as cold sessions (the recipe cannot drift, I-3); only the
    // neutral spawn cwd and the slot overlay path differ.
    const makeSlotRuntime = (request: {
      readonly slotOverlayPath: string | undefined;
      readonly keyInput: WarmKeyInput;
      readonly currentThreadId: () => string;
    }) =>
      makeQwenAcpRuntime({
        qwenSettings,
        ...(options?.environment ? { environment: options.environment } : {}),
        childProcessSpawner,
        cliJs: resolved.bin,
        // Neutral spawn cwd — pre-session the process is project-
        // agnostic; the thread's cwd arrives via bindAndStart.
        cwd: serverConfig.stateDir,
        ...(request.slotOverlayPath !== undefined || request.keyInput.allowedMcpServers.length > 0
          ? {
              settingsOverlay: {
                ...(request.slotOverlayPath !== undefined
                  ? { settingsOverlayPath: request.slotOverlayPath }
                  : {}),
                allowedMcpServers: request.keyInput.allowedMcpServers,
              },
            }
          : {}),
        clientInfo: { name: "t3-code", version: "0.0.0" },
        // Same failure-only logger as cold sessions; the threadId is
        // "warm-slot" until the slot is taken.
        requestLogger: (event) =>
          event.status === "failed" && !(event.cause && Cause.hasInterruptsOnly(event.cause))
            ? Effect.logError("[cli-acp.request.failed]", {
                threadId: request.currentThreadId(),
                profile: resolved.profile.id, // ru-code
                method: event.method,
                payload: describeRequestPayload(event.payload),
                ...(event.cause ? describeRequestFailure(event.cause) : {}),
              })
            : Effect.void,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

    const warmPool = warmEngine
      ? yield* Effect.gen(function* () {
          yield* Effect.ignore(fileSystem.remove(warmDir, { recursive: true, force: true }));
          return yield* makeWarmAcpPool<AcpSessionRuntimeShape>({
            warmDir,
            // The generic recipe: empty allowlist; overlay-env presence follows
            // the MCP-engine gate (with the engine on, every start carries an
            // overlay path — an empty one for projects without tools).
            genericKeyInput: { overlayPresent: MCP_ENGINE_USE_OVERLAY, allowedMcpServers: [] },
            genericTarget: options?.poolOptions?.genericTarget ?? PREWARM_GENERIC_INSTANCES,
            mcpTarget: options?.poolOptions?.mcpTarget ?? MCP_PREWARM_INSTANCES,
            mcpMaxProjects: options?.poolOptions?.mcpMaxProjects ?? MCP_PREWARM_MAX_PROJECTS,
            breakerFails: options?.poolOptions?.breakerFails ?? WARM_REFILL_BREAKER_FAILS,
            maxAgeEnabled: options?.poolOptions?.maxAgeEnabled ?? WARM_SLOT_MAX_AGE_ENABLED,
            maxAgeMs: options?.poolOptions?.maxAgeMs ?? WARM_SLOT_MAX_AGE_MS,
            warmupTimeoutMs: options?.poolOptions?.warmupTimeoutMs ?? WARM_SLOT_WARMUP_TIMEOUT_MS,
            nextSlotId: cryptoUuid,
            makeRuntime: (request) =>
              Effect.gen(function* () {
                // Journal the warm spawn; the entry drops when the slot's
                // scope closes — pool discard/evict/drain, or (after take)
                // the owning session's teardown. The remove-finalizer is
                // registered BEFORE the spawn (via the pid box) so the LIFO
                // scope close runs the spawner's kill FIRST and the journal
                // drop LAST — the journal never forgets a still-alive child.
                let journaledPid: number | null = null;
                if (processJournal !== undefined) {
                  yield* Effect.addFinalizer(() =>
                    journaledPid !== null ? processJournal.remove(journaledPid) : Effect.void,
                  );
                }
                const runtime = yield* makeSlotRuntime(request);
                if (processJournal !== undefined) {
                  journaledPid = runtime.childPid;
                  yield* processJournal.record({ pid: runtime.childPid, kind: "warm" });
                }
                return runtime;
              }),
          });
        })
      : undefined;
    // ru-code (warm engine): boot prewarm — only the first/default qwen
    // instance keeps the generic pool hot from app start (a chat's very first
    // send lands on a prewarmed process); other configured instances pool
    // lazily on their first use.
    const prewarmOnCreate =
      options?.prewarmOnCreate ?? boundInstanceId === defaultInstanceIdForDriver(PROVIDER);
    if (warmPool !== undefined && prewarmOnCreate) {
      // ru-code (Fix W): with FirstClientConnected in context the prewarm is
      // forked onto the adapter layer scope and gated on the first client
      // attach (the heavy CLI boot must not compete with the first connect);
      // without the service it is awaited inline as before. NO timers.
      yield* triggerGenericPrewarm(warmPool.prewarmGeneric, layerScope);
    }

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(cryptoUuid, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    // ru-code: channel A of model discovery — persist qwen's session-start
    // advertisement (the FULL catalog) for this instance. Empty advertisement
    // ⇒ broken run, keep the current set. Never fails a session start: the
    // store's own persistence errors are already swallowed inside it.
    const modelDiscoveryStore = options?.modelDiscoveryStore;
    const persistSessionModelDiscovery = (
      setupResult: Parameters<typeof discoveredModelsFromSessionSetup>[0],
    ) =>
      Effect.gen(function* () {
        if (!QWEN_MODELS_AUTO_DISCOVERY) return;
        if (!modelDiscoveryStore) return;
        const discoveredModels = discoveredModelsFromSessionSetup(setupResult);
        if (discoveredModels.length === 0) {
          yield* Effect.logDebug("[qwen-model-discovery] empty advertisement — keeping set", {
            instanceId: boundInstanceId,
          });
          return;
        }
        yield* modelDiscoveryStore.applyAdvertisement(boundInstanceId, discoveredModels);
        yield* Effect.logDebug("[qwen-model-discovery] session advertised models", {
          instanceId: boundInstanceId,
          slugs: discoveredModels.map((model) => model.slug),
        });
      });

    // ru-code: channel B of model discovery — a model-not-found error drops the
    // dead model and merges backend-suggested replacements. The raw details are
    // debug-logged verbatim so real backend prose can tighten the patterns.
    const applyModelErrorDiscovery = (detailsText: string, sentModelSlug: string | null) =>
      Effect.gen(function* () {
        if (!QWEN_MODELS_AUTO_DISCOVERY) return;
        if (!modelDiscoveryStore) return;
        const discovery = detectModelErrorDiscovery({ detailsText, sentModelSlug });
        if (discovery === null) return;
        yield* Effect.logDebug("[qwen-model-discovery] model error detected", {
          instanceId: boundInstanceId,
          badModelSlug: discovery.badModelSlug,
          suggestedSlugs: discovery.suggestedModels.map((model) => model.slug),
          detailsText,
        });
        yield* modelDiscoveryStore.applyModelError({
          instanceId: boundInstanceId,
          badModelSlug: discovery.badModelSlug,
          suggestedModels: discovery.suggestedModels,
        });
      });

    // ru-code: per-model meter denominator — the context window of the model
    // the thread currently runs (`ctx.currentModelSlug`, set by sendTurn).
    // Reads the live discovered set so a fresh discovery corrects the window
    // mid-session; falls back to CONTEXT_WINDOW_TOKENS via the pure resolver.
    const currentContextWindowTokens = (
      ctx: QwenSessionContext | undefined,
    ): Effect.Effect<number> =>
      Effect.gen(function* () {
        const discoveredModels = modelDiscoveryStore
          ? yield* modelDiscoveryStore.get(boundInstanceId)
          : [];
        return resolveQwenModelContextWindow(qwenSettings, discoveredModels, ctx?.currentModelSlug);
      });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    /**
     * ru-code (sub-agents): the agent row's LIVE LINE. `task.progress.summary`
     * is the only channel the panel row prefers (subagentRuntime.ts:519-527 is
     * the sole writer of `RuntimeSubagent.progress`, and AgentsPanel.tsx:122-140
     * reads it first) — the qwen path emitted zero of these before, which is
     * exactly why every qwen agent row rendered one truncated line. Shape is
     * deliberate parity with the Claude feed (ClaudeAdapter.ts:3263-3274):
     * description + summary + lastToolName + role. Every call also re-stamps the
     * agent linkage so a fold that never saw the start row still classifies the
     * task as an agent (`taskType` → ingestion's `agentKind: "agent"`).
     */
    const offerAgentProgress = (
      ctx: QwenSessionContext,
      window: QwenAgentWindow,
      fields: {
        readonly summary?: string;
        readonly lastToolName?: string;
        readonly status?: RuntimeTaskStatus;
      },
    ) =>
      Effect.flatMap(makeEventStamp(), (stamp) =>
        offerRuntimeEvent({
          type: "task.progress",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(window.taskId),
            description: window.description,
            taskType: QWEN_SUBAGENT_TASK_TYPE,
            toolUseId: window.taskId,
            ...(window.role ? { role: window.role } : {}),
            ...(fields.summary ? { summary: fields.summary } : {}),
            ...(fields.lastToolName ? { lastToolName: fields.lastToolName } : {}),
            ...(fields.status ? { status: fields.status } : {}),
          },
        }),
      );

    /**
     * ru-code (P2 zombie settle): the ONLY `task.completed` a sub-agent open
     * at teardown ever gets when its own `AgentRootSettled` loses the race —
     * teardown interrupts the notification fiber, so that frame (if qwen was
     * about to send it) is never drained. Mirrors `AgentRootSettled`
     * (:2250-2291) field-for-field: flush the pending narration line first
     * (often the only thing the row ever shows on a cancelled run), then
     * close the task terminal with `status: "stopped"`.
     *
     * Idempotency guard: clearing `ctx.subAgentWindow` FIRST (before any
     * yield) means a real `AgentRootSettled` that already closed the window
     * makes this a no-op, and a second teardown call is also a no-op —
     * mirrors Claude's `liveTaskIds.delete` guard (ClaudeAdapter.ts).
     */
    const settleOpenSubAgentAsStopped = (ctx: QwenSessionContext) =>
      Effect.gen(function* () {
        const window = ctx.subAgentWindow;
        if (window === undefined) return;
        ctx.subAgentWindow = undefined;
        const tail = takeQwenAgentLine(window);
        if (tail !== undefined) {
          yield* offerAgentProgress(ctx, window, { summary: tail });
        }
        yield* offerRuntimeEvent({
          type: "task.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(window.taskId),
            status: "stopped",
            taskType: QWEN_SUBAGENT_TASK_TYPE,
            toolUseId: window.toolUseId,
            ...(window.title ? { title: window.title } : {}),
            ...(window.role ? { role: window.role } : {}),
            detail: "Stopped by the user.",
          },
        });
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) {
          return Effect.succeed([existing, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        const eventId = yield* cryptoUuid;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: eventId,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<QwenSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    // ru-code (warm engine): the INSTANT client-side settle shared by the
    // regular stop and the coordinated shutdown — everything the user (and
    // the event pipeline) observes, with zero waiting on the dying process:
    // queue `session/cancel` (a plain outgoing write; a dead transport fails
    // it as a typed error, swallowed), interrupt the notification/child-exit/
    // prompt fibers (streaming freezes; the turn settles `cancelled` into
    // sendTurn's finalizer), await the I5 barrier (now instant), unregister
    // the session and emit `session.exited`. The process itself is NOT killed
    // here — the caller owns the cancel→grace→SIGKILL tail.
    const settleActiveTurnForTeardown = (ctx: QwenSessionContext, method: AbortMethod) =>
      Effect.gen(function* () {
        yield* Effect.ignore(ctx.acp.cancel);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        if (ctx.childExitFiber) {
          yield* Fiber.interrupt(ctx.childExitFiber);
        }
        if (ctx.activePromptFiber) {
          yield* Fiber.interrupt(ctx.activePromptFiber);
        }
        // Same I5 ordering barrier as the classic path — now instant: the
        // interrupted prompt settles into sendTurn's finalizer without
        // waiting on the process. Defensively bounded: sendTurn's onExit
        // safety net makes an unresolved turnFinalized unreachable, but a
        // stop must never be able to hang on it regardless.
        if (ctx.turnFinalized !== undefined) {
          yield* Deferred.await(ctx.turnFinalized).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(cancelGraceMs),
              orElse: () =>
                Effect.logError("[cli-adapter] turn finalizer barrier timed out — proceeding", {
                  threadId: ctx.threadId,
                }),
            }),
          );
        }
        sessions.delete(ctx.threadId);
        if (method === MAINTENANCE_METHOD) {
          yield* SynchronizedRef.update(threadLocksRef, (locks) => {
            const next = new Map(locks);
            next.delete(ctx.threadId);
            return next;
          });
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * End an ACP session using one of the three strategies in AbortMethod
     * (see contracts/providerRuntime). Picking the right method per call
     * site is how we balance cleanup vs hang-resistance:
     *
     *   "cancel-turn"
     *     ACP `session/cancel` only. Session, child process, and
     *     conversation context all survive. Use when the agent honours
     *     cancel reliably.
     *
     *   "end-graceful"
     *     ACP cancel, then close the scope (SIGTERM the child). Lets the
     *     agent flush logs, shut down MCP subprocesses, etc. Can hang if
     *     the agent ignores cancel + SIGTERM — the original mode-change
     *     hang we hit before `acp.cancel`-before-scope-close was added.
     *
     *   "end-force"
     *     SIGKILL the child directly, no cancel ceremony. Unmaskable by
     *     the OS — cannot hang. Skips the agent's own cleanup. Use when
     *     the session is being discarded anyway and hang-resistance
     *     trumps cleanup.
     *
     * Errors are swallowed (`Effect.ignore`) — once we've decided to tear
     * something down, surfacing a partial failure is less useful than
     * continuing the teardown.
     */
    // ru-code (warm engine): the shared kill→close→latch-resolve tail —
    // used by the single-stop detached teardown and stopAll's batch tail.
    // Byte-identical semantics in both: SIGKILL, close the session scope,
    // drop the latch registration only if it is still OURS (a successor's
    // latch must survive), then release the waiter.
    const finishSessionTeardown = (
      ctx: QwenSessionContext,
      teardownLatch: Deferred.Deferred<void>,
    ) =>
      ctx.acp.forceKill.pipe(
        Effect.andThen(Effect.ignore(Scope.close(ctx.scope, Exit.void))),
        Effect.andThen(
          Effect.sync(() => {
            if (teardownLatches.get(ctx.threadId) === teardownLatch) {
              teardownLatches.delete(ctx.threadId);
            }
          }),
        ),
        Effect.andThen(Deferred.succeed(teardownLatch, undefined)),
        Effect.asVoid,
      );

    const abortSession = (
      ctx: QwenSessionContext,
      method: AbortMethod,
      options?: {
        /**
         * ru-code (warm engine): stopAll's instant-kill batch forces the
         * classic inline path even when a prompt fiber appeared between its
         * partition and this call — a detached grace teardown here would let
         * the child outlive stopAll's "everything dead on return" contract.
         */
        readonly disallowDetachedTeardown?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (method === "cancel-turn") {
          // Don't mark stopped — the session continues. Just unblock any
          // held permission deferreds and tell the agent to end the turn.
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
          yield* Effect.ignore(ctx.acp.cancel);
          yield* Effect.logDebug("[cli-adapter] ACP session aborted", {
            threadId: ctx.threadId,
            method,
            sessionTornDown: false,
          });
          return;
        }

        // end-graceful or end-force: full teardown. The ENTIRE claim-to-
        // completion region is UNINTERRUPTIBLE: the claim (`ctx.stopped`)
        // must never be separable from the teardown it promises — an
        // interrupt landing between them would leave a claimed-but-alive
        // child that no later stop can reach (requireSession rejects stopped
        // sessions). Every step inside is bounded: settles are event/interrupt
        // work, the finalizer barrier is time-bounded, and kills are SIGKILL.
        // A pending external interrupt is delivered at the region's boundary,
        // after everything below completed or was forked.
        if (ctx.stopped) {
          yield* Effect.logDebug("[cli-adapter] ACP session abort skipped (already stopped)", {
            threadId: ctx.threadId,
            method,
          });
          return;
        }
        yield* Effect.uninterruptible(abortSessionTeardown(ctx, method, options));
      });

    const abortSessionTeardown = (
      ctx: QwenSessionContext,
      method: AbortMethod,
      options?: { readonly disallowDetachedTeardown?: boolean },
    ) =>
      Effect.gen(function* () {
        ctx.stopped = true;

        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        // ru-code (P2 zombie settle): before either teardown branch below
        // interrupts the notification fiber — the real `AgentRootSettled`
        // (if any) would otherwise be lost and the agent row would zombie.
        yield* settleOpenSubAgentAsStopped(ctx);

        // ru-code (warm engine): instant-settle stop. An end-force teardown
        // with a prompt actually in flight settles the turn CLIENT-SIDE at
        // ~0ms (settleActiveTurnForTeardown) and runs cancel→grace→SIGKILL
        // against the dying process in a DETACHED background fiber — the user
        // never waits on it. `session/cancel` is what lets qwen reap detached
        // shell process-groups and finish its synchronous session-file appends
        // (killing after the prompt settled removes the torn-JSONL-line
        // window); the SIGKILL after the grace is the unmaskable backstop.
        // Crash-driven teardowns (childExitObserved) and the pre/post-prompt
        // phases keep the classic inline path below — identical to today.
        if (
          warmEngine &&
          method === "end-force" &&
          options?.disallowDetachedTeardown !== true &&
          ctx.activeTurnId !== undefined &&
          ctx.activePromptFiber !== undefined &&
          !ctx.childExitObserved
        ) {
          yield* settleActiveTurnForTeardown(ctx, method);
          const teardownLatch = yield* Deferred.make<void>();
          teardownLatches.set(ctx.threadId, teardownLatch);
          if (adapterClosing) {
            // The layer scope is closing — a forkIn there would be dropped
            // before it ever evaluates (no grace, no kill). Finish inline
            // and immediately; the process is going down anyway.
            yield* finishSessionTeardown(ctx, teardownLatch);
          } else {
            // Detached teardown: give the cancelled agent up to the grace to
            // reap its children and flush its files, then SIGKILL and close
            // the scope. The kill+close+latch tail rides `Effect.onExit`, so
            // it runs even when the fiber is interrupted mid-grace — the
            // child can never leak and a latch waiter can never hang.
            yield* Effect.race(
              ctx.acp.waitForExit,
              Effect.sleep(Duration.millis(cancelGraceMs)),
            ).pipe(
              Effect.onExit(() => finishSessionTeardown(ctx, teardownLatch)),
              Effect.forkIn(layerScope),
              Effect.asVoid,
            );
          }
          yield* Effect.logDebug("[cli-adapter] ACP session aborted", {
            threadId: ctx.threadId,
            method,
            sessionTornDown: true,
            instantSettle: true, // ru-code: warm-engine stop path
          });
          return;
        }

        if (method === "end-graceful") {
          // Give the agent a chance to unwind cleanly. Without this, CLI
          // can hold open RPCs through scope close and the SIGTERM
          // finalizer awaits forever.
          yield* Effect.ignore(ctx.acp.cancel);
        }

        // The notification fiber drains acp.getEvents() forever; it must
        // be interrupted before the ACP runtime goes away or we leak.
        // Same for the child-exit fiber — it's tied to this session's
        // lifetime and must die with it.
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        if (ctx.childExitFiber) {
          yield* Fiber.interrupt(ctx.childExitFiber);
        }

        if (method === "end-force") {
          // SIGKILL — kernel reaps the child unconditionally, so the
          // spawn finalizer's child.exited promise resolves immediately
          // and the subsequent Scope.close completes without waiting.
          // It also makes any in-flight `acp.prompt()` fail (transport EOF),
          // which drives sendTurn's finalizer below.
          yield* ctx.acp.forceKill;
        }

        // ru-code: SINGLE-WRITER ordering barrier. If a turn is in flight, the
        // kill above (or, for end-graceful, the `acp.cancel`) makes its prompt
        // settle into sendTurn's finalizer, which emits THE one `turn.completed`
        // for this turn and resolves `turnFinalized`. We must let that event be
        // offered BEFORE our `session.exited` — ingestion strips the per-turn
        // assistant-message cache on `session.exited`, and finalizing the
        // message after that strip leaves the bubble timer stuck (I5). The kill
        // guarantees the prompt settles, so this await cannot hang.
        if (ctx.activeTurnId !== undefined && ctx.turnFinalized !== undefined) {
          // Defensively bounded like the instant-settle barrier: the kill
          // guarantees the prompt settles, but a stop must never be able to
          // hang here regardless (this runs inside the uninterruptible
          // teardown region).
          yield* Deferred.await(ctx.turnFinalized).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(cancelGraceMs),
              orElse: () =>
                Effect.logError("[cli-adapter] turn finalizer barrier timed out — proceeding", {
                  threadId: ctx.threadId,
                }),
            }),
          );
        }

        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        // ru-code: on a genuine session-lifecycle end (stopSession / stopAll / reaper /
        // shutdown, all MAINTENANCE_METHOD) drop the per-thread lock too, so a long-lived
        // server doesn't retain one Semaphore per thread ever seen. Restart-style teardowns
        // (mode-change / stop-button) keep the lock — a follow-up turn reuses it.
        if (method === MAINTENANCE_METHOD) {
          yield* SynchronizedRef.update(threadLocksRef, (locks) => {
            const next = new Map(locks);
            next.delete(ctx.threadId);
            return next;
          });
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
        yield* Effect.logDebug("[cli-adapter] ACP session aborted", {
          threadId: ctx.threadId,
          method,
          sessionTornDown: true,
        });
      });

    // ru-code: run `abortSession` on a fresh fiber in the adapter-layer scope.
    // Used by the session-bound fibers (child-exit watcher), which must NOT
    // call `abortSession` inline: `abortSession` interrupts those very fibers,
    // so an inline call would self-interrupt and never reach `session.exited`.
    // Forking onto the layer scope decouples the teardown from the fiber that
    // triggered it.
    const scheduleTeardown = (ctx: QwenSessionContext, method: AbortMethod) =>
      abortSession(ctx, method).pipe(Effect.forkIn(layerScope), Effect.asVoid);

    const startSession: QwenAdapterShape["startSession"] = (input) => {
      // ru-code (warm engine): set once the "starting" feedback left the
      // adapter — a failed start then compensates with a terminal state.
      let startingEmitted = false;
      // ru-code (warm engine): set once the session is REGISTERED (scope
      // custody handed to `sessions`); read by the custody finalizer and by
      // the compensating-event guard on the pipe below.
      let sessionScopeTransferred = false;
      return withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}', got '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "No working directory (cwd) specified.",
            });
          }

          // ru-code (warm engine): instant "working" feedback — emitted the
          // moment the start begins, so the web flips to the "connecting"
          // busy phase with zero delay (cold spawn, teardown latch, warm
          // bind alike). Safe at 0ms because of the preserve-modes seam
          // (ThreadSessionSetCommand): ingestion's carried-over fields are
          // re-resolved at the decider's serialized execution, so this event
          // can never clobber a concurrent start-failure banner; and a failed
          // start compensates with a terminal state (see the start's onExit compensating event below)
          // so the projection can never stick at "starting".
          if (warmEngine) {
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "starting", reason: "Cli ACP session starting" },
            });
            startingEmitted = true;
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            // ru-code: a mid-turn restart (model/cwd change) is a cancel, not a
            // failure — flag it so the old turn's finalizer labels it cancelled.
            existing.userCancelRequested = true;
            yield* abortSession(existing, MODE_CHANGE_METHOD);
          }

          // ru-code (warm engine): if this thread's previous process is still
          // inside its detached cancel→grace→SIGKILL window, wait for it to
          // die before binding — it must stop appending to the session JSONL
          // before `session/load` re-reads it. Bounded by grace + kill; the
          // latch always resolves. This is the ONLY wait in the stop system,
          // and §2.2b above renders it as "connecting".
          if (warmEngine) {
            const teardownLatch = teardownLatches.get(input.threadId);
            if (teardownLatch !== undefined) {
              yield* Deferred.await(teardownLatch);
            }
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();

          const resumeSessionId = parseQwenResume(input.resumeCursor)?.sessionId;

          // ru-code: the per-project MCP overlay resolved by the provider-command reactor at
          // turn-start (path to qwen's highest-precedence settings file + server allowlist).
          // Absent ⇒ spawn byte-for-byte identical to a no-MCP app (kill-switch off / no overlay).
          const settingsOverlay =
            input.settingsOverlayPath !== undefined || input.allowedMcpServers !== undefined
              ? {
                  ...(input.settingsOverlayPath !== undefined
                    ? { settingsOverlayPath: input.settingsOverlayPath }
                    : {}),
                  ...(input.allowedMcpServers !== undefined
                    ? { allowedMcpServers: input.allowedMcpServers }
                    : {}),
                }
              : undefined;

          // ru-code (warm engine): take a matching warm slot. The key mirrors
          // exactly what the classic spawn bakes (I-3): overlay-env presence +
          // the argv allowlist, both under the MCP_ENGINE_USE_OVERLAY gate.
          const warmKeyInput: WarmKeyInput = {
            overlayPresent: MCP_ENGINE_USE_OVERLAY && input.settingsOverlayPath !== undefined,
            allowedMcpServers: MCP_ENGINE_USE_OVERLAY ? (input.allowedMcpServers ?? []) : [],
          };
          // ru-code: MCP-project identity for the per-project pools — the
          // overlay path is `<overlayDir>/<projectId>/system.json` by the MCP
          // manager's contract; generic (no enabled tools) requests carry null.
          const derivedWarmProjectId =
            warmKeyInput.allowedMcpServers.length > 0 && input.settingsOverlayPath !== undefined
              ? path.basename(path.dirname(input.settingsOverlayPath))
              : null;
          // Defensive: if the overlay path ever stops following the
          // `<overlayDir>/<projectId>/system.json` contract, a degenerate
          // basename must not become a pool identity — the start goes cold
          // (take logs the miss) instead of polluting a wrong bucket.
          const warmProjectId =
            derivedWarmProjectId !== null &&
            derivedWarmProjectId !== "" &&
            derivedWarmProjectId !== "." &&
            derivedWarmProjectId !== ".."
              ? derivedWarmProjectId
              : null;
          const warmRequest: WarmTakeRequest = {
            keyInput: warmKeyInput,
            projectId: warmProjectId,
            threadId: input.threadId,
          };
          let pooledSlot: TakenWarmSlot<AcpSessionRuntimeShape> | null = null;
          // Scope custody, FINALIZER-FIRST: the closing finalizer is
          // registered BEFORE the pool take, against mutable boxes — an
          // external interrupt landing anywhere between the pool handing the
          // slot over and this start completing can therefore never orphan a
          // live child (the boxes already own whatever exists). The runtime
          // is boxed alongside the scope so an abandonment close can SIGKILL
          // FIRST — the spawner's release is SIGTERM + an unbounded
          // wait-for-exit, which a SIGTERM-surviving child would block.
          let ownedSessionScope: Scope.Closeable | null = null;
          let ownedSlotRuntime: AcpSessionRuntimeShape | null = null;
          yield* Effect.addFinalizer(() =>
            ownedSessionScope !== null && !sessionScopeTransferred
              ? (ownedSlotRuntime !== null ? ownedSlotRuntime.forceKill : Effect.void).pipe(
                  Effect.andThen(Effect.ignore(Scope.close(ownedSessionScope, Exit.void))),
                )
              : Effect.void,
          );
          if (warmPool !== undefined) {
            // Uninterruptible WITH the custody assignment INSIDE the region:
            // a pending external interrupt is delivered AT the region's
            // boundary (the continuation after it never runs), so boxing the
            // slot after the region would lose it — the tap keeps take and
            // custody one atomic step.
            pooledSlot = yield* Effect.uninterruptible(
              warmPool.take(warmRequest).pipe(
                Effect.tap((taken) =>
                  Effect.sync(() => {
                    ownedSessionScope = taken?.scope ?? null;
                    ownedSlotRuntime = taken?.runtime ?? null;
                  }),
                ),
              ),
            );
            if (pooledSlot !== null && warmKeyInput.overlayPresent) {
              // The slot was spawned pointing at its own overlay path; feed it
              // the CANONICAL overlay bytes (alive throughout startSession, G9)
              // before the bind reads settings. 0600/0700 — the copy holds
              // resolved secrets, exactly like the canonical file.
              const canonicalPath = input.settingsOverlayPath!;
              const slotOverlayPath = pooledSlot.slotOverlayPath!;
              // Ephemeral-secret hygiene, registered BEFORE the write: the
              // copy (even a torn, partially-written one on failure) and its
              // slot dir are removed when this start settles — success, error,
              // or interrupt.
              yield* Effect.addFinalizer(() =>
                Effect.ignore(
                  fileSystem.remove(path.dirname(slotOverlayPath), {
                    recursive: true,
                    force: true,
                  }),
                ),
              );
              const copied = yield* Effect.gen(function* () {
                const contents = yield* fileSystem.readFileString(canonicalPath);
                yield* fileSystem.makeDirectory(path.dirname(slotOverlayPath), {
                  recursive: true,
                  mode: 0o700,
                });
                yield* fileSystem.writeFileString(slotOverlayPath, contents, { mode: 0o600 });
              }).pipe(Effect.exit);
              if (Exit.isFailure(copied)) {
                // Discard the slot and go cold — the canonical file is still
                // there for the classic spawn (failure-mode table §2.7).
                yield* Effect.logDebug("[acp-pool] slot overlay copy failed — going cold", {
                  threadId: input.threadId,
                  slotOverlayPath,
                });
                yield* pooledSlot.runtime.forceKill;
                yield* Effect.ignore(Scope.close(pooledSlot.scope, Exit.void));
                pooledSlot = null;
                ownedSessionScope = null;
                ownedSlotRuntime = null;
              }
            }
            if (pooledSlot !== null) {
              pooledSlot.setThreadId(input.threadId);
              // The child now serves a session — keep the journal truthful
              // (the re-record flips `kind` only; the original spawnedAt is
              // preserved by the journal).
              if (processJournal !== undefined) {
                yield* processJournal.record({
                  pid: pooledSlot.runtime.childPid,
                  kind: "session",
                });
              }
            }
          }

          // Pooled: adopt the slot's scope — finalizer semantics identical to
          // a fresh session scope (a bind failure closes it ⇒ child killed).
          const sessionScope = pooledSlot?.scope ?? (yield* Scope.make("sequential"));
          ownedSessionScope = sessionScope;
          // Cold-path journal remove-finalizer, registered BEFORE the runtime
          // spawn adds the spawner's kill release to this scope: the LIFO
          // close then kills the child FIRST and drops the journal entry
          // LAST — the journal never forgets a still-alive child. (Pooled
          // slots get the identical ordering inside the pool's makeRuntime.)
          let coldJournaledPid: number | null = null;
          if (processJournal !== undefined && pooledSlot === null) {
            yield* Scope.addFinalizer(
              sessionScope,
              Effect.suspend(() =>
                coldJournaledPid !== null ? processJournal.remove(coldJournaledPid) : Effect.void,
              ),
            );
          }
          let ctx!: QwenSessionContext;

          const acp =
            pooledSlot !== null
              ? pooledSlot.runtime
              : yield* makeQwenAcpRuntime({
                  qwenSettings,
                  ...(options?.environment ? { environment: options.environment } : {}),
                  childProcessSpawner,
                  // ru-code: resolved bin — a cli.js is spawned as `node <cliJs> --acp`, a
                  // bare command runs directly (see buildCliSpawn). Per-instance via profile
                  // default / binaryPath override, falling back to the boot preflight cli.js.
                  cliJs: resolved.bin,
                  cwd,
                  ...(settingsOverlay ? { settingsOverlay } : {}),
                  clientInfo: { name: "t3-code", version: "0.0.0" },
                  ...(resumeSessionId ? { resumeSessionId } : {}),
                  // ru-code: log every failed RPC at error level with the pretty-
                  // printed Cause. This is the only triage breadcrumb we keep after
                  // the empty-stream investigation — it's failure-only (no noise on
                  // healthy turns) and contains everything we need to identify a new
                  // class of cli-side error without re-enabling wire dumps.
                  //
                  // Cause.hasInterruptsOnly filters out cancellations (user clicks
                  // Stop, session torn down, supersede).
                  // Those are deliberate teardowns, not errors — logging them as
                  // "request.failed" was just noise.
                  requestLogger: (event) =>
                    event.status === "failed" &&
                    !(event.cause && Cause.hasInterruptsOnly(event.cause))
                      ? Effect.logError("[cli-acp.request.failed]", {
                          threadId: input.threadId,
                          profile: resolved.profile.id, // ru-code: which brand (custom fork / stock qwen)
                          method: event.method,
                          payload: describeRequestPayload(event.payload),
                          ...(event.cause ? describeRequestFailure(event.cause) : {}),
                        })
                      : Effect.void,
                }).pipe(
                  Effect.provideService(Scope.Scope, sessionScope),
                  Effect.provideService(Crypto.Crypto, crypto),
                  // ru-code: capture the original stream-side cause at the
                  // boundary — `mapAcpToAdapterError` below wraps it in a
                  // `ProviderAdapterProcessError` whose `.cause` is preserved
                  // but whose pretty-printed `Cause` chain in higher-level
                  // handlers loses the original frames. Logging here keeps the
                  // root cause grep-able under a stable tag.
                  Effect.tapError((cause) =>
                    Effect.logError("[cli-acp.stream-error]", {
                      threadId: input.threadId,
                      profile: resolved.profile.id, // ru-code
                      ...describeRequestFailure(Cause.fail(cause)),
                    }),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: input.threadId,
                        detail: cause.message,
                        cause,
                      }),
                  ),
                  // ru-code: a spawn failure (B3) surfaces here as a
                  // `ProviderAdapterProcessError` wrapping the `AcpSpawnError`; remap it
                  // to a `ProviderAdapterRequestError` carrying the classified B3 text so
                  // the reactor's pre-turn start-failure path shows the classified banner.
                  Effect.mapError((error) =>
                    remapStartFailureThroughClassifier("session/start", error),
                  ),
                );

          // The cold runtime now exists — box it so the custody finalizer's
          // abandonment close can SIGKILL first (same guarantee as pooled).
          ownedSlotRuntime = acp;

          // ru-code (warm engine): journal the cold session spawn; the entry
          // drops when the session scope closes (every kill path ends there —
          // see the remove-finalizer registered above, BEFORE the spawn).
          // Pooled slots were journaled at their warm spawn.
          if (processJournal !== undefined && pooledSlot === null) {
            coldJournaledPid = acp.childPid;
            yield* processJournal.record({ pid: acp.childPid, kind: "session" });
          }

          const started = yield* Effect.gen(function* () {
            // ru-code: catch every CLI vendor extension notification.
            // Always log the raw payload so unknown methods surface.
            // For slash-command progress + result notifications (compress,
            // summary, ...), synthesise a `content.delta` event so the text
            // lands in the active turn's assistant bubble — same pipeline
            // real `agent_message_chunk` text uses. Only the vendor namespace
            // prefix varies by CLI build (`_qwencode/…`, `_vendor/…`, a
            // fork's own), the payload is identical — so match the stable
            // `/slash_command` suffix instead of enumerating vendors.
            yield* acp.handleUnknownExtNotification((method, params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, method, params, "acp.jsonrpc");
                yield* Effect.logDebug("[cli-acp] ext notification received", {
                  threadId: input.threadId,
                  method,
                  params,
                });

                if (!method.endsWith("/slash_command")) return;

                const record = isRecord(params) ? params : undefined;
                const rawMessage = record?.message;
                const message = typeof rawMessage === "string" ? rawMessage : "";
                if (message.length === 0) return;

                const messageType = record?.messageType;

                // ru-code: qwen streams the /compress flow as English text only
                // ("Compressing context..." then "Context compressed (X -> Y).")
                // with no _meta.usage (its ACP slash path returns end_turn before
                // emitUsageMetadata — Session.ts). Localize the bubble text and,
                // on success, emit a token-usage update so the context meter
                // snaps to the post-compaction size. Format is a raw,
                // non-localized string in cli 0.13.1 (compressCommand.ts).
                const compaction = /Context compressed \((\d+)\s*->\s*(\d+)\)/.exec(message);

                // ru-code: HIDDEN compaction (compactContext) — no user turn is
                // active and nothing must land in a bubble. Stash the outcome
                // for the awaiting compactContext call (it emits the timeline
                // row); the meter update below still fires.
                if (ctx?.hiddenCompressActive) {
                  if (messageType === "error") {
                    ctx.hiddenCompressOutcome = { kind: "error", message };
                  } else if (compaction) {
                    // Raw numbers, not a formatted string — compactContext
                    // formats the row AND feeds the circuit breaker off them.
                    ctx.hiddenCompressOutcome = {
                      kind: "success",
                      preTokens: Number(compaction[1]),
                      postTokens: Number(compaction[2]),
                    };
                  }
                } else {
                  let text: string;
                  if (messageType === "error") {
                    text = `❌ ${message}\n`;
                  } else if (message.startsWith("Compressing context")) {
                    text = "Compacting context, please wait…\n";
                  } else if (compaction) {
                    text = `\nCompaction succeeded (${compaction[1]} -> ${compaction[2]}).\n`;
                  } else {
                    text = `${message}\n`;
                  }

                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      text,
                      rawPayload: params,
                    }),
                  );
                }

                // ru-code: emit the post-compaction size so the meter updates.
                if (compaction && messageType !== "error") {
                  const newTokenCount = Number(compaction[2]);
                  if (Number.isFinite(newTokenCount) && newTokenCount >= 0) {
                    // ru-code: keep the live-feed dedupe cursor in step so the next
                    // agent_message_chunk carrying this same size doesn't re-fire.
                    if (ctx) ctx.lastEmittedUsedTokens = newTokenCount;
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {
                          usedTokens: newTokenCount,
                          maxTokens: yield* currentContextWindowTokens(ctx),
                        },
                      },
                    });
                  }
                }
              }),
            );
            // ru-code: read through a function call, not a bare `ctx?.stopped`
            // comparison — the guard below is re-checked at 4 sites inside ONE
            // callback invocation, and TypeScript's control-flow analysis narrows
            // a repeated `ctx?.stopped === true` to a statically-false comparison
            // after the first early-return, since it cannot see that a CONCURRENT
            // fiber (the Stop path, `abortSessionTeardown:1125`) mutates `ctx.stopped`
            // during this callback's suspension points (`yield* cryptoUuid`,
            // `yield* Deferred.make`) — exactly the race Fix 1 exists to close.
            // The function-call boundary defeats that (incorrect, for this case)
            // narrowing.
            const isCtxStopped = () => ctx?.stopped === true;
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  params,
                  "acp.jsonrpc",
                );

                // ru-code: raw approval trace — shows EXACTLY what qwen asked to
                // confirm this turn (plan / tool / mcp / question / other) and how we
                // classify it, so a "plan not surfacing" can be diagnosed at a glance.
                yield* Effect.logDebug("[cli-acp] approval requested (raw)", {
                  threadId: input.threadId,
                  toolName: readToolName(params),
                  isExitPlan:
                    readToolName(params) === "exit_plan_mode" ||
                    Boolean(readExitPlanPayload(params)),
                  isAskQuestion:
                    readToolName(params) === "ask_user_question" ||
                    Boolean(readAskQuestionsPayload(params)),
                  optionKinds: params.options.map((option) => option.kind),
                  rawParams: params,
                });

                // ru-code: ingress guard — a permission RPC that arrives after
                // the Stop button has already flipped ctx.stopped must be
                // refused before any side effect (sub-agent `waiting` marker,
                // `turn.proposed.completed`, request registration) fires, or a
                // tail request survives the warm-path detached teardown grace
                // with no live session left to close it. See the atomic
                // re-checks at each `pendingApprovals`/`pendingUserInputs.set`
                // site below for the interleaving window this alone does not
                // close.
                if (isCtxStopped()) {
                  return { outcome: { outcome: "cancelled" as const } };
                }

                // Branch 1 — ask_user_question: surface as a structured
                // user-input request the existing Cursor/OpenCode UI handles.
                const toolName = readToolName(params);
                // ru-code (sub-agents): a permission request inside a root-agent
                // window is the CHILD asking. It is NOT suppressed and NOT parked
                // — the child's prompt() is blocked on the answer, so hiding it
                // would deadlock the run; it keeps every existing surface below
                // untouched. What the window adds is the missing half: the agent
                // row is marked `waiting` with a wordless pause line, so the panel
                // says WHICH agent is holding for you instead of reading "Working"
                // while nothing happens. Any later child frame moves it back to
                // running (subagentRuntime.ts:515-521), so no un-marking is owed.
                if (ctx?.subAgentWindow !== undefined) {
                  yield* offerAgentProgress(ctx, ctx.subAgentWindow, {
                    summary: formatQwenAgentWaitingLine(toolName),
                    status: "waiting",
                  });
                }
                const questionsPayload = readAskQuestionsPayload(params);
                if (toolName === "ask_user_question" || questionsPayload) {
                  if (!questionsPayload) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const { questions, questionIndexById } = normalizeQwenQuestions(questionsPayload);
                  const requestId = ApprovalRequestId.make(yield* cryptoUuid);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
                  // ru-code: atomic re-check — no suspension point between
                  // this read and the `.set` below, so a Stop that flips
                  // ctx.stopped either lands before this line (refused here)
                  // or after the `.set` (caught by settlePendingUserInputs...).
                  if (isCtxStopped()) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  pendingUserInputs.set(requestId, {
                    answers: answersDeferred,
                    questionIndexById,
                  });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    requestId: runtimeRequestId,
                    payload: { questions },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      payload: params,
                    },
                  });
                  const collectedAnswers = yield* Deferred.await(answersDeferred);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    requestId: runtimeRequestId,
                    payload: { answers: collectedAnswers },
                  });
                  const encodedAnswers = encodeQwenAnswersForPermission(
                    collectedAnswers,
                    questionIndexById,
                  );
                  if (Object.keys(encodedAnswers).length === 0) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const submitOptionId = selectQwenSubmitOptionId(params);
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: submitOptionId,
                    },
                    // Sibling field on the response — Cli reads
                    // `output.answers` (Session.ts:1513-1517 in cli-code).
                    // The schema for this field was added manually to
                    // `_generated/schema.gen.ts`.
                    answers: encodedAnswers,
                  };
                }

                // Branch 2 — exit_plan_mode: surface the plan via
                // `turn.proposed.completed`, then HOLD the permission RPC open
                // until the user reacts (clicks Implement, sends a refining
                // message, or interrupts). Replying `cancelled` immediately
                // makes Cli retry/loop because its tool returns "Plan
                // execution was not approved. Remaining in plan mode." to the
                // LLM, which then decides what to do — and that decision is
                // unstable across cwd contexts (notably git presence, since
                // cli-code's system prompt has a `# Git Repository` section
                // gated on `isGitRepository(cwd)` in
                // cli-code/packages/core/src/core/prompts.ts:302). Holding
                // the request makes Cli's prompt() block until we resolve,
                // matching the same pattern used for `ask_user_question`.
                // The existing `interruptTurn` flow calls
                // `settlePendingApprovalsAsCancelled` which resolves the
                // deferred with "cancel" when the user takes any action that
                // dispatches `thread.turn.interrupt`.
                const planPayload = readExitPlanPayload(params);
                if (toolName === "exit_plan_mode" || planPayload) {
                  if (!planPayload) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  yield* offerRuntimeEvent({
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    payload: { planMarkdown: planPayload.plan },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      payload: params,
                    },
                  });
                  const requestId = ApprovalRequestId.make(yield* cryptoUuid);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  // ru-code: atomic re-check — see the note at the
                  // ask_user_question `.set` site above; same shape here.
                  if (isCtxStopped()) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  pendingApprovals.set(requestId, { decision, kind: "exit_plan_mode" });
                  // Surface the held-open RPC as a plan_approval request so the
                  // projection knows Cli is parked waiting for a plan decision.
                  // The UI keys off `hasPendingPlanApproval` to flip from
                  // "Working" → "Plan ready" and stop the streaming timer.
                  yield* offerRuntimeEvent({
                    type: "request.opened",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    requestId: runtimeRequestId,
                    payload: { requestType: "plan_approval" },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "request.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                    requestId: runtimeRequestId,
                    payload: { requestType: "plan_approval", decision: resolved },
                  });
                  // ru-code: optionId controls CLI's approvalMode for the
                  // SAME-turn implementation that runs immediately after plan
                  // accept (cli-code/packages/core/src/tools/exitPlanMode.ts
                  // :96-118 — onConfirm mutates ApprovalMode synchronously
                  // before returning). The per-turn setMode is too late for that
                  // same-turn work, so derive the optionId from the RESOLVED
                  // decision rather than the runtimeMode mirror: an approve-time
                  // full-access toggle reaches this parked callback as the web's
                  // "acceptForSession" decision, so this path honours it with no
                  // SPI change (the stale mirror would miss that toggle).
                  //   acceptForSession → proceed_always → CLI AUTO_EDIT
                  //   accept           → proceed_once   → CLI DEFAULT
                  const approveOptionId: "proceed_once" | "proceed_always" =
                    resolved === "acceptForSession" ? "proceed_always" : "proceed_once";
                  let wireOutcome:
                    | { outcome: "selected"; optionId: "proceed_once" | "proceed_always" }
                    | { outcome: "cancelled" };
                  if (resolved === "accept" || resolved === "acceptForSession") {
                    wireOutcome = { outcome: "selected", optionId: approveOptionId };
                  } else {
                    wireOutcome = { outcome: "cancelled" };
                  }
                  return { outcome: wireOutcome };
                }

                // ru-code: read live runtimeMode from ctx — refreshed on
                // every sendTurn. The startSession-closure runtimeMode is fine
                // at session start but goes stale once the user toggles the
                // dropdown (no session restart now).
                if (ctx.currentRuntimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* cryptoUuid);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                // ru-code: atomic re-check — see the note at the
                // ask_user_question `.set` site above; same shape here.
                if (isCtxStopped()) {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    // @effect-diagnostics-next-line preferSchemaOverJson:off - params is unknown; debug-only truncated repr for the detail fallback.
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const targetKind = decisionToPermissionKind(resolved);
                if (targetKind === null) {
                  return { outcome: { outcome: "cancelled" } as const };
                }
                const matchedOptionId = findPermissionOptionIdByKind(params.options, targetKind);
                if (matchedOptionId === null) {
                  yield* Effect.logDebug(
                    "[cli-acp] agent omitted expected permission kind; cancelling",
                    {
                      threadId: input.threadId,
                      decision: resolved,
                      expectedKind: targetKind,
                      receivedKinds: params.options.map((o) => o.kind),
                    },
                  );
                  return { outcome: { outcome: "cancelled" } as const };
                }
                return {
                  outcome: { outcome: "selected" as const, optionId: matchedOptionId },
                };
              }),
            );
            // ru-code (warm engine): a pooled slot binds with THIS thread's
            // cwd/resume cursor (its creation options carry the neutral spawn
            // cwd); the classic runtime keeps its byte-identical start()
            // (≡ bindAndStart of its own creation options).
            return yield* pooledSlot !== null
              ? acp.bindAndStart({
                  cwd,
                  ...(resumeSessionId ? { resumeSessionId } : {}),
                })
              : acp.start();
          }).pipe(
            // ru-code: capture the CLI exit code at the boundary —
            // `mapAcpToAdapterError` below wraps `AcpProcessExitedError`
            // in `ProviderAdapterSessionClosedError`, dropping `.code` from
            // structured log fields.
            Effect.tapError((error) =>
              isAcpProcessExitedError(error)
                ? Effect.logError("[cli-acp.process-exited]", {
                    threadId: input.threadId,
                    method: "session/start",
                    exitCode: error.code,
                  })
                : Effect.void,
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
            // ru-code: hard ceiling on the start handshake. Nothing else bounds it
            // (the child-exit watchdog is forked only AFTER start and acts only
            // during an active turn). On timeout the interrupt unwinds the
            // pending `initialize`/`session.new` RPC and the session scope closes,
            // SIGKILLing the child; we surface a typed adapter error so callers
            // (and the reactor's overlay finalizer) see a settled failure.
            Effect.timeoutOrElse({
              duration: Duration.millis(sessionStartTimeoutMs),
              orElse: () =>
                Effect.logError("[cli-acp.start-timeout]", {
                  threadId: input.threadId,
                  method: "session/start",
                  timeoutMs: sessionStartTimeoutMs,
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: input.threadId,
                        detail: `ACP session did not complete its start handshake within ${sessionStartTimeoutMs}ms — the cli --acp child is unresponsive.`,
                        cause: new Error("acp-session-start-timeout"),
                      }),
                    ),
                  ),
                ),
            }),
            // ru-code: a classifiable start-handshake failure (process exit, auth,
            // transport) is remapped to a `ProviderAdapterRequestError` carrying the
            // classified text — same pre-turn start-failure seam as the B3 spawn case
            // above. Non-classifiable failures pass through unchanged.
            Effect.mapError((error) => remapStartFailureThroughClassifier("session/start", error)),
          );

          const resumeOutcome: "fresh" | "resumed" | "resume-fallback-fresh" =
            resumeSessionId === undefined
              ? "fresh"
              : started.sessionId === resumeSessionId
                ? "resumed"
                : "resume-fallback-fresh";
          yield* Effect.logDebug("[cli-adapter] ACP session started", {
            threadId: input.threadId,
            cwd,
            requestedResumeSessionId: resumeSessionId ?? null,
            startedSessionId: started.sessionId,
            outcome: resumeOutcome,
          });
          // ru-code: channel A — qwen advertised its full model catalog in the
          // session/new / session/load response; persist it for this instance.
          yield* persistSessionModelDiscovery(started.sessionSetupResult);
          // Diagnostic: dump full session/new response. Uncomment when triaging wire-level issues.
          // yield* Effect.logInfo("[cli-adapter] session/new initializeResult", {
          //   threadId: input.threadId,
          //   initializeResult: started.initializeResult,
          // });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: QWEN_RESUME_VERSION,
              sessionId: started.sessionId,
            } satisfies QwenResumeCursor,
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            childExitFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            itemTurnIds: new Map(),
            lastTurnId: undefined,
            turnFinalized: undefined,
            userCancelRequested: false,
            stopped: false,
            activePromptFiber: undefined, // ru-code: warm engine
            childExitObserved: false, // ru-code: warm engine

            // ru-code: seed the live runtimeMode mirror from startSession
            // input (the orchestrator passes thread.runtimeMode here). Future
            // sendTurn / respondToRequest calls refresh it.
            currentRuntimeMode: input.runtimeMode,
            // ru-code: lastEmittedUsedTokens left absent — no token-usage emitted
            // yet this session; the live feed sets it on the first CHANGED value.
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted": {
                    // ru-code: pin the item to its turn NOW — completion may be
                    // consumed after the finalizer cleared `activeTurnId`. The
                    // whole decision lives in itemTurnAttribution.ts (unit-pinned).
                    const startedTurnId = attributeItemStarted(
                      ctx.itemTurnIds,
                      itemAttributionState(ctx),
                      event.itemId,
                    );
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: startedTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  }
                  case "AssistantItemCompleted": {
                    const completedTurnId = attributeItemCompleted(
                      ctx.itemTurnIds,
                      itemAttributionState(ctx),
                      event.itemId,
                    );
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: completedTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated": {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    // ru-code (sub-agents): a `plan` frame inside a root-agent
                    // window is the CHILD's todo list (PlanEmitter takes no meta,
                    // so it arrives unstamped — window proof applies). Forwarding
                    // it would REPLACE the user's own visible task list with the
                    // child's, which is a corruption, not a leak. Parked on the
                    // agent row instead: progress count + the live step, so
                    // nothing the user needs is lost.
                    const planWindow = ctx.subAgentWindow;
                    if (planWindow !== undefined) {
                      const planLine = formatQwenAgentPlanLine(event.payload);
                      if (planLine !== undefined && planLine !== planWindow.emitted) {
                        planWindow.emitted = planLine;
                        yield* offerAgentProgress(ctx, planWindow, { summary: planLine });
                      }
                      return;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ToolCallUpdated": {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    // ru-code: qwen tags sub-agent frames in `update._meta`. The item
                    // event is built exactly as before; the classification decides what
                    // ELSE the frame means for the Agents surface. A frame with no
                    // sub-agent meta takes the default arm and is byte-identical to
                    // today's behaviour.
                    const agentFrame = classifyQwenToolCallFrame(event.toolCall, event.rawPayload);
                    const itemEvent = makeAcpToolCallEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    });
                    switch (agentFrame._tag) {
                      case "AgentRootStarted": {
                        // ru-code (sub-agents): open the attribution window. From
                        // here until this call settles, every UNSTAMPED frame is
                        // this child's — see the window proof in QwenAcpSubAgents.
                        ctx.subAgentWindow = openQwenAgentWindow(agentFrame);
                        // Open the task BEFORE its content: the chat's spawn-CTA row
                        // anchors on the first task row of the batch, and the fold only
                        // accepts tool.progress heartbeats for a task it already knows.
                        yield* offerRuntimeEvent({
                          type: "task.started",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                          payload: {
                            taskId: RuntimeTaskId.make(agentFrame.taskId),
                            taskType: QWEN_SUBAGENT_TASK_TYPE,
                            toolUseId: agentFrame.toolUseId,
                            // `title` is what the panel row shows; `description` is what
                            // ingestion turns into the row detail the CTA anchors on.
                            ...(agentFrame.title
                              ? { title: agentFrame.title, description: agentFrame.title }
                              : {}),
                            ...(agentFrame.role ? { role: agentFrame.role } : {}),
                          },
                        });
                        yield* offerRuntimeEvent(
                          withQwenAgentAttribution(itemEvent, agentFrame.taskId),
                        );
                        return;
                      }
                      case "AgentRootSettled": {
                        // ru-code (sub-agents): flush whatever narration is still
                        // under the quantum, then close the window. Without the
                        // flush an agent that ends mid-sentence loses its last
                        // words — and on a run with no result at all (a cancel)
                        // that flushed line is the ONLY thing the row ever shows.
                        const settlingWindow = ctx.subAgentWindow;
                        if (settlingWindow?.taskId === agentFrame.taskId) {
                          const tail = takeQwenAgentLine(settlingWindow);
                          if (tail !== undefined) {
                            yield* offerAgentProgress(ctx, settlingWindow, { summary: tail });
                          }
                          ctx.subAgentWindow = undefined;
                        }
                        // Close the task AFTER its content, mirroring the open above.
                        yield* offerRuntimeEvent(
                          withQwenAgentAttribution(itemEvent, agentFrame.taskId),
                        );
                        yield* offerRuntimeEvent({
                          type: "task.completed",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                          payload: {
                            taskId: RuntimeTaskId.make(agentFrame.taskId),
                            status: agentFrame.status,
                            taskType: QWEN_SUBAGENT_TASK_TYPE,
                            toolUseId: agentFrame.toolUseId,
                            ...(agentFrame.summary ? { summary: agentFrame.summary } : {}),
                            ...(agentFrame.title ? { title: agentFrame.title } : {}),
                            ...(agentFrame.role ? { role: agentFrame.role } : {}),
                            ...(agentFrame.typedUsage ? { typedUsage: agentFrame.typedUsage } : {}),
                            // ru-code (sub-agents): qwen's own reason for an early
                            // exit, on the contract's long-form body field.
                            ...(agentFrame.terminateReason
                              ? { detail: agentFrame.terminateReason }
                              : {}),
                          },
                        });
                        return;
                      }
                      case "AgentInnerTool": {
                        // ru-code (sub-agents): the tool's RESULT, on the terminal
                        // frame, is the single most informative thing the child
                        // produces — and `tool.progress` cannot carry it (the fold
                        // reads only taskId + toolName from that arm,
                        // subagentRuntime.ts:610-623). So a settled inner call with
                        // result text ALSO goes out as `task.progress`: the
                        // heartbeat below is unchanged, and the extra row is what
                        // puts the result into `progress` and the activity ring.
                        // The agent's live activity line ("▸ read_file"). Ingestion keys
                        // these under one stable id per task, so a long run costs one row.
                        yield* offerRuntimeEvent({
                          type: "tool.progress",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                          payload: {
                            taskId: RuntimeTaskId.make(agentFrame.taskId),
                            ...(agentFrame.toolName ? { toolName: agentFrame.toolName } : {}),
                            toolUseId: agentFrame.toolUseId,
                            parentToolUseId: agentFrame.taskId,
                          },
                        });
                        const innerWindow = ctx.subAgentWindow;
                        const innerLine = agentFrame.settled
                          ? formatQwenAgentToolLine(agentFrame.toolName, agentFrame.detail)
                          : undefined;
                        if (
                          innerLine !== undefined &&
                          innerWindow !== undefined &&
                          innerWindow.taskId === agentFrame.taskId
                        ) {
                          innerWindow.emitted = innerLine;
                          yield* offerAgentProgress(ctx, innerWindow, {
                            summary: innerLine,
                            ...(agentFrame.toolName ? { lastToolName: agentFrame.toolName } : {}),
                          });
                        }
                        yield* offerRuntimeEvent(
                          withQwenAgentAttribution(itemEvent, agentFrame.taskId),
                        );
                        return;
                      }
                      default:
                        yield* offerRuntimeEvent(itemEvent);
                        return;
                    }
                  }
                  case "ContentDelta": {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    // ru-code (sub-agents): THE re-route. An unstamped text chunk
                    // arriving inside a root-agent window is the child's narration
                    // (qwen drops the meta at SubAgentTracker.ts:275; the window
                    // proof in QwenAcpSubAgents.ts supplies the attribution). It
                    // must never become a `content.delta`, or the child's whole
                    // monologue is spliced into the parent's chat bubble. It
                    // becomes the agent row's live line instead — the same channel
                    // ClaudeAdapter.ts:3263 feeds for its children.
                    const textWindow = ctx.subAgentWindow;
                    if (textWindow !== undefined) {
                      const line = appendQwenAgentText(textWindow, event.text);
                      if (line !== undefined) {
                        yield* offerAgentProgress(ctx, textWindow, { summary: line });
                      }
                      return;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        // ru-code: same per-item pin as the lifecycle events —
                        // a delta trailing the prompt response must carry the
                        // turn its item was started under, not the (possibly
                        // already-cleared) active marker.
                        turnId: attributeItemDelta(
                          ctx.itemTurnIds,
                          itemAttributionState(ctx),
                          event.itemId,
                        ),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "UsageUpdated": {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    // ru-code (sub-agents): qwen emits per-SUB-AGENT usage on its own
                    // empty-text agent_message_chunk, distinguished only by
                    // `_meta.parentToolCallId` (SubAgentTracker → emitUsageMetadata).
                    // A child's prompt tokens are its own context, not the thread's:
                    // letting them through moves the context meter AND feeds the
                    // auto-compaction trigger, which reads the same counter. The frame
                    // is still logged natively above — only the meter skips it.
                    if (isQwenSubAgentFrame(event.rawPayload)) return;
                    // ru-code: live token feed. The parser emits UsageUpdated for
                    // EVERY agent_message_chunk carrying _meta.usage.inputTokens —
                    // including qwen's dedicated empty-text usage frame (which produces
                    // no ContentDelta). Emit thread.token-usage.updated, deduped against
                    // ctx.lastEmittedUsedTokens so only real changes move the meter.
                    const usedTokens = extractQwenInputTokens(event.rawPayload);
                    if (usedTokens !== null && usedTokens !== ctx.lastEmittedUsedTokens) {
                      ctx.lastEmittedUsedTokens = usedTokens;
                      yield* offerRuntimeEvent({
                        type: "thread.token-usage.updated",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                        payload: {
                          usage: {
                            usedTokens,
                            maxTokens: yield* currentContextWindowTokens(ctx),
                          },
                        },
                      });
                    }
                    return;
                  }
                }
              }),
            ),
            // ru-code: fork into the SESSION scope, never as a child of the
            // calling fiber. This drain is the only consumer of every ACP
            // `session/update`; a forkChild here dies the moment the caller
            // completes (effect v4 interrupts children on parent completion),
            // which left sessions started from short-lived fibers (e.g.
            // ProviderService recovery on the reactor's compaction fiber)
            // permanently deaf: prompts resolved, chunks were enqueued, nothing
            // was ever drained. Session-scoped, it dies exactly at teardown —
            // which is what `abortSession` already assumes.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;

          // Layer A — child-exit watcher. If CLI dies on its own
          // (crash, OOM, killed by another process) while a turn is
          // active, the in-flight `acp.prompt()` will never return
          // and the UI's turn timer would tick forever. Detect the
          // exit and force a teardown so the next user message
          // starts a fresh session.
          const childExitFiber = yield* Effect.gen(function* () {
            yield* acp.waitForExit;
            if (ctx.stopped) return;
            // ru-code (warm engine): mark the teardown as crash-driven BEFORE
            // scheduling it — abortSession must take the classic path so the
            // in-flight turn settles through the classifier (B1.<code>), never
            // the instant-settle cancel label.
            ctx.childExitObserved = true;
            yield* Effect.logDebug("[cli-adapter] ACP child exited unexpectedly", {
              threadId: ctx.threadId,
              activeTurnId: ctx.activeTurnId ?? null,
            });
            // ru-code: schedule (don't inline) — see scheduleTeardown. If a
            // turn was active, the child's death already failed its prompt into
            // the finalizer; abortSession awaits that turn.completed before
            // session.exited. If idle, this is plain cleanup. Covers B1
            // (process-exit, killAcp:false) which the reactor won't tear down.
            yield* scheduleTeardown(ctx, MAINTENANCE_METHOD);
            // ru-code: session-scoped for the same reason as the drain above —
            // the watcher must outlive whichever fiber happened to start the
            // session, or a CLI crash after that fiber completes goes unnoticed.
          }).pipe(Effect.forkIn(sessionScope));
          ctx.childExitFiber = childExitFiber;

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // ru-code (warm engine): refill only after a successful bind (I-8) —
          // idle slot deaths are never auto-respawned, so no crash-loops. The
          // spawn is inline (deterministic counts); the warmup RPCs fork.
          if (warmPool !== undefined) {
            yield* warmPool.ensureAfterSuccess(warmRequest);
          }

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cli ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(
          // ru-code (warm engine): a failed OR abandoned start must never
          // leave the projected session stuck on "starting" (the web would
          // show "connecting" forever). `Effect.onExit` — NOT tapCause/
          // catchCause — because only onExit-family frames run when the fiber
          // is EXTERNALLY INTERRUPTED (reactor teardown, instance rebuild);
          // a cause-tap would be skipped and the abandonment would strand the
          // projection. The compensating terminal event rides the SAME
          // ingestion queue as the starting event, so it is processed
          // strictly after it; the reactor's own failure write and this one
          // converge on a terminal status under every interleaving (its
          // status logic keeps "stopped", and the preserve-modes seam keeps
          // its lastError banner).
          Effect.onExit((exit) =>
            // `sessionScopeTransferred` = the session was REGISTERED: an
            // interrupt after that point abandons a LIVE session (the next
            // start supersedes it) — compensating with "stopped" there would
            // wrongly mark a running session stopped.
            !Exit.isSuccess(exit) && startingEmitted && !sessionScopeTransferred
              ? makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent({
                      type: "session.state.changed",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: input.threadId,
                      payload: { state: "stopped", reason: "Cli ACP session start failed" },
                    }),
                  ),
                )
              : Effect.void,
          ),
          Effect.scoped,
        ),
      );
    };

    const sendTurn: QwenAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // ru-code: turnId + turn.started are the genuine FIRST acts — emitted
        // BEFORE requireSession — so EVERY exit from this turn (a requireSession
        // / D2 failure, a validation / D1 failure, a prompt failure, a defect,
        // or success) is finalized into exactly one `turn.completed` by the
        // onExit finalizer below. That finalizer is the SINGLE source of the
        // failed-turn event: it carries the classified text + surface (so
        // ingestion is the single writer of timeline row / banner / message-
        // finalize) and the real turnId (never a projection read). No `ctx` is
        // needed to emit — `finalized` is a local first-wins flag and the
        // threadId/turnId are local.
        const turnId = TurnId.make(yield* cryptoUuid);
        let finalized = false;
        let activeCtx: QwenSessionContext | undefined;
        const turnFinalized = yield* Deferred.make<void>();

        const finalize = (opts: {
          readonly state: "completed" | "cancelled" | "failed";
          readonly stopReason: string | null;
          readonly errorMessage?: string;
          readonly showNotification?: boolean;
          // ru-code: when the classified surface set includes Timeline, the exact
          // classified text is emitted as its own tone:"error" work-log row via
          // task.completed — independent of the banner (showNotification, which
          // rides turn.completed) and the bubble (content.delta). This is a
          // control field, stripped from the turn.completed wire payload below.
          readonly timelineText?: string;
        }) =>
          Effect.gen(function* () {
            if (finalized) return; // check-and-set, no yield between ⇒ atomic
            finalized = true;
            if (activeCtx) activeCtx.activeTurnId = undefined; // clear the active turn marker
            const { timelineText, ...payload } = opts;
            // ru-code: Timeline surface → a failed-task work-log row carrying the
            // exact classified text as its summary, emitted BEFORE the
            // turn.completed lifecycle event.
            if (timelineText !== undefined) {
              yield* offerRuntimeEvent({
                type: "task.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  taskId: RuntimeTaskId.make(`${CLI_ERROR_TASK_PREFIX}${turnId}`),
                  taskType: CLI_ERROR_TASK_TYPE,
                  status: "failed",
                  summary: timelineText,
                },
              });
            }
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload,
            });
            // Release abortSession's ordering barrier (I5): a `session.exited`
            // may now safely follow this `turn.completed` on the same consumer.
            yield* Deferred.succeed(turnFinalized, undefined);
          });

        // Cancel (user Stop / mode-change set userCancelRequested before the
        // kill, or a genuine fiber interrupt) is NOT an error. Anything else is
        // classified into a failed surface. The intent flag is read here, set
        // before the kill that fails the prompt ⇒ deterministic label, no race.
        const finalizeFromCause = (cause: Cause.Cause<unknown>) =>
          activeCtx?.userCancelRequested === true || Cause.hasInterruptsOnly(cause)
            ? finalize({ state: "cancelled", stopReason: "cancelled" })
            : Effect.gen(function* () {
                const error = cause.reasons.find(Cause.isFailReason)?.error;
                // ru-code: classification must NEVER gate the single-writer emit — a
                // throw here would silence the turn AND hang teardown (turnFinalized
                // never resolves). Fall back to the generic decision on any throw.
                let decision = (() => {
                  try {
                    return classify(error, cause, resolved.artifact) ?? UNRECOGNIZED_DECISION;
                  } catch {
                    return UNRECOGNIZED_DECISION;
                  }
                })();
                // ru-code: B1 exit-code recovery. effect-acp's `callRpc` collapses a
                // mid-prompt child exit into an `AcpTransportError` (wrapping a generic
                // `RpcClientError`) at the RPC boundary, erasing the underlying
                // `AcpProcessExitedError` — so `classify()` lands on C4. If the child
                // actually exited, re-read its real status and re-classify → B1.<code>
                // / B2 (bounded, so a genuine child-alive transport break stays C4).
                if (decision.id === "C4" && activeCtx !== undefined) {
                  const childExit = yield* activeCtx.acp.readChildExit;
                  if (childExit.exited) {
                    const exitError = new EffectAcpErrors.AcpProcessExitedError(
                      childExit.code !== undefined ? { code: childExit.code } : {},
                    );
                    decision = (() => {
                      try {
                        return (
                          classify(exitError, Cause.fail(exitError), resolved.artifact) ?? decision
                        );
                      } catch {
                        // keep the C4 decision on any classify throw
                        return decision;
                      }
                    })();
                  }
                }
                // Emit FIRST (the one critical write), THEN log the `[runtime]`
                // breadcrumb best-effort: built lazily inside Effect.sync so a throw in
                // describeRequestFailure can't gate the emit, and `ignore`d so a log
                // failure can't fail the finalizer. The turn is finalized either way.
                yield* finalize({
                  state: "failed",
                  stopReason: "failed",
                  ...(decision.text !== undefined ? { errorMessage: decision.text } : {}),
                  // ru-code: banner (Notification) and timeline row (Timeline) are
                  // independent members of the decision's surface set.
                  showNotification: hasSurface(decision, Surface.Notification),
                  ...(decision.text !== undefined && hasSurface(decision, Surface.Timeline)
                    ? { timelineText: decision.text }
                    : {}),
                });
                yield* Effect.sync(() => ({
                  source: "cli",
                  where: "turn",
                  threadId: input.threadId,
                  profile: resolved.profile.id, // ru-code
                  ...cliErrorFields(decision, describeRequestFailure(cause)),
                })).pipe(
                  Effect.flatMap((fields) => Effect.logError("[runtime]", fields)),
                  Effect.ignore,
                );
              });

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: input.modelSelection?.model },
        });

        return yield* Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          // Fail fast while a hidden /compress runs — the ACP session is
          // serial and compression can take minutes; queueing would look like
          // a hang. The B5 recognizer pins this detail's surfaces.
          if (ctx.hiddenCompressActive) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: COMPRESS_IN_PROGRESS_DETAIL,
            });
          }
          activeCtx = ctx;
          ctx.activeTurnId = turnId;
          // ru-code: survives the finalizer's activeTurnId clear — attribution
          // fallback for items/deltas trailing the prompt response.
          ctx.lastTurnId = turnId;
          ctx.turnFinalized = turnFinalized;
          ctx.userCancelRequested = false;

          // ru-code: fault-injection seam for the E (defect) error path. E is a
          // synchronous throw that escapes the Effect error channel (Cause.die);
          // no ACP wire input can induce it, so this env-gated throw lets the
          // fake-ACP e2e prove that a mid-turn defect still finalizes as E
          // (Timeline surface, killAcp) without hanging the turn. No-op in
          // production (the env var is never set outside tests).
          if (process.env["RU_CODE_FAULT_INJECT"] === "defect") {
            throw new Error("ru-code fault-injection: synthetic mid-turn defect");
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            // ru-code: strip the chip fences AND inject the right system-reminder (single skill/agent,
            // or a CHAIN reminder for 2+ chips) in one step; see buildComposerReminder.
            const composerReminder = buildComposerReminder(input.input.trim());
            if (composerReminder.applied) {
              yield* Effect.logDebug("[qwen-adapter] composer system-reminder applied", {
                threadId: input.threadId,
              });
            }
            promptParts.push({ type: "text", text: composerReminder.text });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "A message must contain text or attachments.",
            });
          }

          // ru-code: resolve both composer dropdowns (interactionMode +
          // runtimeMode) to CLI's ApprovalMode and send setMode every turn.
          // Refresh the live runtimeMode mirror from THIS turn's input first (the
          // reactor stamps thread.runtimeMode on every turn), then resolve from it
          // — so a mid-session runtime-mode toggle reaches the CLI via per-turn
          // setMode with no session respawn. Fall back to the existing mirror when
          // the input omits it. AcpSessionRuntime.setMode (AcpSessionRuntime.ts
          // :565-575) no-ops when currentModeId already matches, so unconditional
          // per-turn calls are free. Errors are logged + swallowed; the server-side
          // short-circuit above is the safety net.
          ctx.currentRuntimeMode = input.runtimeMode ?? ctx.currentRuntimeMode; // ru-code: refresh live mirror
          // ru-code: refresh the per-model meter denominator's model mirror.
          if (input.modelSelection?.model) {
            ctx.currentModelSlug = input.modelSelection.model;
          }
          const targetMode = resolveQwenMode({
            interactionMode: input.interactionMode,
            runtimeMode: ctx.currentRuntimeMode,
          });
          // ru-code: the exact value sent to ACP this turn (mode "plan" ⇒ qwen plans).
          yield* Effect.logDebug("[cli-acp] → setMode", {
            threadId: input.threadId,
            mode: targetMode,
          });
          yield* ctx.acp.setMode(targetMode).pipe(
            Effect.catch((error) =>
              Effect.logDebug("[cli-acp] setMode failed", {
                threadId: input.threadId,
                requestedMode: targetMode,
                error: error.message,
              }),
            ),
          );

          // ru-code: send the picker-selected model to qwen every turn.
          // setConfigOption is idempotent (no-ops when the value already
          // matches), so unconditional per-turn calls are free. Errors are
          // logged + swallowed, mirroring the setMode pattern above.
          // Empty model ("Default model", 0 served models) skips setModel
          // — the CLI runs its own defaults; blocking would deadlock stock-qwen
          // bootstrap (discovery needs a session, a session needs a send).
          if (input.modelSelection?.model) {
            // ru-code: qwen selects both model AND auth in-session via the encoded
            // `${slug}(${authMethod})` (its formatAcpModelId). authMethod is the
            // SERVED model's own — a discovered model's auth comes from the
            // session advertisement, not from settings (dispatching the
            // instance default for it makes qwen reject the setModel).
            const discoveredModelsForAuth = modelDiscoveryStore
              ? yield* modelDiscoveryStore.get(boundInstanceId)
              : [];
            const authMethod = resolveServedModelAuthMethod(
              qwenSettings,
              serveQwenModels(qwenSettings, discoveredModelsForAuth),
              input.modelSelection.model,
            );
            const encodedModel = formatQwenModelId(input.modelSelection.model, authMethod);
            // ru-code: the exact value sent to ACP — `${slug}(${authMethod})`.
            yield* Effect.logDebug("[cli-acp] → setModel", {
              threadId: input.threadId,
              encodedModel,
            });
            yield* ctx.acp.setModel(encodedModel).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logError("[cli-acp] setModel failed", {
                    threadId: input.threadId,
                    requestedModel: input.modelSelection?.model,
                    error: error.message,
                  });
                  // ru-code: channel B — a registry miss here is qwen's local
                  // `Model 'X' not found for authType 'Y'` (-32603 details);
                  // drop the dead model so the picker stops offering it.
                  const details = readAcpDetails(error);
                  if (details !== undefined) {
                    yield* applyModelErrorDiscovery(details, input.modelSelection?.model ?? null);
                  }
                }),
              ),
            );
          }

          const promptEffect = ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
              // ru-code: PERMANENT harness diagnostics — the e2e loop's
              // heartbeat (grep `DISPATCH|RESOLVED|FAILED` in app-boot.log is
              // the abort-and-analyze rule's first read). Debug level, and
              // per-TURN frequency — negligible in any Debug-level run.
              (self) =>
                Effect.flatMap(
                  Effect.logDebug("[cli-adapter] prompt DISPATCH", {
                    threadId: input.threadId,
                    parts: promptParts.length,
                  }),
                  () => self,
                ),
              Effect.tap((response) =>
                Effect.logDebug("[cli-adapter] prompt RESOLVED", {
                  threadId: input.threadId,
                  stopReason: response.stopReason,
                }),
              ),
              Effect.tapError((error) =>
                Effect.logDebug("[cli-adapter] prompt FAILED", {
                  threadId: input.threadId,
                  error: String(error),
                }),
              ),
              // ru-code: classify CLI RPC failures through the
              // recognizer registry. **B-surface** decisions (recoverable —
              // rate limit, empty stream, generic -32603 with usable details)
              // are dispatched inline: emit a content.delta with the friendly
              // Russian text and return `{ stopReason: "end_turn" }` so the
              // turn completes cleanly (the finalizer's success arm emits
              // turn.completed{completed}). **Other** decisions (T / T+N) — and
              // any error the classifier doesn't recognize — fall through to
              // `Effect.fail(error)` so `mapAcpToAdapterError` below wraps them
              // and the onExit finalizer classifies + emits turn.completed{failed}.
              Effect.catchTag("AcpRequestError", (error) =>
                Effect.gen(function* () {
                  // ru-code: channel B — backend model-not-found prose rides
                  // the same -32603 details the classifier reads. Update the
                  // model list (remove-bad + add-suggested) as a side effect;
                  // the classifier below stays the single authority for UX.
                  {
                    const details = readAcpDetails(error);
                    if (details !== undefined) {
                      yield* applyModelErrorDiscovery(details, input.modelSelection?.model ?? null);
                    }
                  }
                  const decision = classify(error, Cause.fail(error), resolved.artifact);
                  if (decision !== null && hasSurface(decision, Surface.Bubble)) {
                    yield* Effect.logError("[runtime]", {
                      source: "cli",
                      where: "prompt",
                      threadId: input.threadId,
                      profile: resolved.profile.id, // ru-code
                      ...cliErrorFields(decision, describeRequestFailure(Cause.fail(error))),
                    });
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        // ru-code: always prepend a blank line so the friendly
                        // Bubble-surface text is visually separated from any assistant
                        // text already streamed into the bubble before the error.
                        text: `\n\n${decision.text}`,
                        rawPayload: error.data ?? null,
                      }),
                    );
                    // ru-code: a combined [Bubble, Timeline] decision also emits its
                    // timeline row here — the turn still completes cleanly via the
                    // end_turn response below (finalizer's success arm).
                    if (hasSurface(decision, Surface.Timeline)) {
                      yield* offerRuntimeEvent({
                        type: "task.completed",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        payload: {
                          taskId: RuntimeTaskId.make(`${CLI_ERROR_TASK_PREFIX}${turnId}`),
                          taskType: CLI_ERROR_TASK_TYPE,
                          status: "failed",
                          summary: decision.text,
                        },
                      });
                    }
                    return {
                      stopReason: "end_turn" as const,
                    } satisfies EffectAcpSchema.PromptResponse;
                  }
                  return yield* error;
                }),
              ),
              // ru-code: capture the CLI exit code at the boundary —
              // see the session/start mapError above for rationale.
              Effect.tapError((error) =>
                isAcpProcessExitedError(error)
                  ? Effect.logError("[cli-acp.process-exited]", {
                      threadId: input.threadId,
                      method: "session/prompt",
                      exitCode: error.code,
                    })
                  : Effect.void,
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          // ru-code (warm engine): fork the prompt so the instant-settle stop
          // can interrupt exactly it — the turn then settles cancelled here at
          // ~0ms while the process dies in abortSession's detached background
          // teardown. Gate off ⇒ the prompt runs inline, byte-identical to
          // the classic path.
          let result: EffectAcpSchema.PromptResponse;
          if (warmEngine) {
            const promptFiber = yield* Effect.forkChild(promptEffect);
            ctx.activePromptFiber = promptFiber;
            // Race-closer: a stop that landed during the pre-prompt yields saw
            // no prompt fiber (its abortSession took the classic inline-kill
            // path) — self-interrupt so this turn still settles cancelled and
            // the stop's turnFinalized await can never hang. The assignment
            // above and this read are one synchronous block, so exactly one
            // side always observes the other.
            if (ctx.stopped) {
              yield* Fiber.interrupt(promptFiber);
            }
            const promptExit = yield* Fiber.await(promptFiber);
            ctx.activePromptFiber = undefined;
            if (Exit.isSuccess(promptExit)) {
              result = promptExit.value;
            } else if (Cause.hasInterruptsOnly(promptExit.cause)) {
              // Only the stop paths interrupt the prompt FIBER (a genuine
              // interrupt of this request fiber interrupts Fiber.await itself
              // and propagates through the catchCause below, as today). Settle
              // the turn cancelled — same label + recovery the classic
              // kill-driven stop produces.
              yield* finalize({ state: "cancelled", stopReason: "cancelled" });
              return {
                threadId: input.threadId,
                turnId,
                ...(ctx.session.resumeCursor !== undefined
                  ? { resumeCursor: ctx.session.resumeCursor }
                  : {}),
              };
            } else {
              // Re-inject the prompt failure so the catchCause finalizer
              // classifies it exactly as the classic inline path does.
              result = yield* Effect.failCause(promptExit.cause);
            }
          } else {
            result = yield* promptEffect;
          }

          ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          yield* finalize({
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          });

          // ru-code: auto-compact check AFTER the turn settled — forked onto the
          // adapter layer scope so it survives this request fiber and never
          // delays the turn result. Cancelled turns skip it (the user is
          // steering; the next completed turn re-evaluates).
          if (result.stopReason !== "cancelled") {
            yield* maybeAutoCompactAfterTurn(input.threadId).pipe(Effect.forkIn(layerScope));
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          // ru-code: finalize + KILL THE RACE. On any non-success exit, run the
          // single-writer finalizer (emits THE turn.completed{failed|cancelled}
          // plus the Timeline task.completed row), THEN recover the turn to
          // success so the reactor never sees a sendTurn failure and never fires
          // its generic `recoverTurnStartFailure` — which would write a second,
          // unclassified lastError + timeline row concurrently with the
          // classifier's output. Genuine fiber interrupts still propagate for
          // correct teardown; success was already finalized in the body
          // (finalize() is idempotent anyway).
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* finalizeFromCause(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              return {
                threadId: input.threadId,
                turnId,
                ...(activeCtx?.session.resumeCursor !== undefined
                  ? { resumeCursor: activeCtx.session.resumeCursor }
                  : {}),
              };
            }),
          ),
          // ru-code (warm engine): EXTERNAL-INTERRUPT safety net. Cause
          // frames (the catchCause above) are SKIPPED when this request fiber
          // is externally interrupted (reactor teardown / instance rebuild) —
          // without this, `turnFinalized` would stay unresolved and a later
          // stop would hang on its barrier, with `activePromptFiber` left
          // pointing at a dead fiber. onExit-family frames DO run under
          // interruption; `finalize` is idempotent, so the normal failure
          // path (already finalized above) is unaffected.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  if (activeCtx !== undefined) {
                    activeCtx.activePromptFiber = undefined;
                  }
                  yield* finalizeFromCause(exit.cause);
                }),
          ),
        );
      });

    const interruptTurn: QwenAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // ru-code: Stop is a user CANCEL, not a failure. Flag the intent before
        // the force-kill so sendTurn's finalizer labels the in-flight turn
        // `cancelled` (no error banner) deterministically — the flag is set
        // before the kill that fails the prompt. abortSession runs inline here
        // (this is the request fiber, not a session-bound fiber) and awaits the
        // finalizer's turn.completed before session.exited.
        ctx.userCancelRequested = true;
        yield* abortSession(ctx, STOP_BUTTON_METHOD);
      });

    // HIDDEN context compaction — a "/compress" prompt on the LIVE ACP session,
    // no user turn (the notification handler suppresses bubble deltas while
    // `hiddenCompressActive` and stashes the pre/post token counts on ctx).
    // The timeline gets ONE morphing row keyed by the compaction taskId:
    // task.progress (spinner) BEFORE the prompt, then task.completed with the
    // outcome — success / breaker-warning / failed. Once the progress row is
    // out this call never fails: a thrown error would ALSO add the reactor's
    // failure row (two rows for one action). Pre-start guard violations still
    // throw — no row exists yet, the reactor's failure activity is the surface.
    const compactContext: NonNullable<QwenAdapterShape["compactContext"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Context compaction isn't available while a turn is running.",
          });
        }
        if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail:
              "Context compaction isn't available while the provider is waiting for user input.",
          });
        }
        if (ctx.hiddenCompressActive) return; // one compaction at a time
        ctx.hiddenCompressActive = true;
        ctx.hiddenCompressOutcome = undefined;

        const taskId = RuntimeTaskId.make(`${CONTEXT_COMPACTION_TASK_PREFIX}${yield* cryptoUuid}`);
        // Every path below MUST end the row exactly once; the onExit finalizer
        // closes it on the paths that can't reach a completeTask call
        // (fiber interruption: session teardown, instance rebuild, shutdown).
        let compactionRowClosed = false;
        // ru-code: set once qwen CONFIRMS the compression ("Context compressed
        // (X -> Y)"). Drives the post-compaction session teardown below — see
        // COMPACTION_RESTART_METHOD for why the session must not live on.
        let compressionConfirmed = false;
        const completeTask = (payload: {
          readonly status: "completed" | "failed" | "stopped";
          readonly summary: string;
          // Expandable body under the visible title (advice/explanations).
          readonly detail?: string;
          readonly tone?: "warning";
          // Raw numbers ride the event so the circuit breaker can re-derive
          // its state from persisted history after a restart.
          readonly usage?: { readonly preTokens: number; readonly postTokens: number };
        }) =>
          Effect.flatMap(makeEventStamp(), (stamp) =>
            offerRuntimeEvent({
              type: "task.completed",
              ...stamp,
              provider: PROVIDER,
              threadId,
              // ru-code: same self-describing stamp as the progress row — every
              // closing path of the compaction (success, warning, failure, live
              // interrupt) funnels through completeTask, so one line covers them all.
              payload: { taskId, taskType: CONTEXT_COMPACTION_TASK_TYPE, ...payload },
            }),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                compactionRowClosed = true;
              }),
            ),
          );

        yield* offerRuntimeEvent({
          type: "task.progress",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          // ru-code: taskType makes the row self-describing on the wire. Ingestion
          // computes agentKind from it (it is never copied from the payload), and
          // the literal is inert, so this pair stays out of the Agents surface and
          // renders as the ordinary morphing chat row it is.
          payload: {
            taskId,
            taskType: CONTEXT_COMPACTION_TASK_TYPE,
            description: "Compacting context…",
          },
        });

        yield* ctx.acp.prompt({ prompt: [{ type: "text", text: "/compress" }] }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* Effect.logDebug("[cli-adapter] hidden compress prompt failed", {
                  threadId,
                  error,
                });
                const failureDetail =
                  "detail" in error && typeof error.detail === "string" && error.detail.length > 0
                    ? error.detail
                    : error.message;
                yield* completeTask({
                  status: "failed",
                  summary: `Could not compact the context: ${failureDetail}`,
                });
              }),
            onSuccess: (promptResult) =>
              Effect.gen(function* () {
                // Read via a helper: the `= undefined` write above narrows the
                // ctx property for TS, but the notification fiber mutates it
                // during the prompt — the call boundary defeats the narrowing.
                const outcome = readHiddenCompressOutcome(ctx);
                ctx.hiddenCompressOutcome = undefined;
                if (outcome?.kind !== "success") {
                  yield* completeTask({
                    status: "failed",
                    summary:
                      outcome?.kind === "error"
                        ? outcome.message
                        : `The provider did not confirm context compaction (stopReason: ${promptResult.stopReason ?? "unknown"}).`,
                  });
                  return;
                }
                // qwen compressed and recorded it — every branch below (plain
                // success AND the low-gain warnings) is a real compression.
                compressionConfirmed = true;
                const numbers = `(${outcome.preTokens} -> ${outcome.postTokens})`;
                const usage = { preTokens: outcome.preTokens, postTokens: outcome.postTokens };
                const windowTokens = yield* currentContextWindowTokens(ctx);
                if (outcome.postTokens >= windowTokens * AUTO_COMPACT_DISARM_FRACTION) {
                  // Circuit breaker trip — the warning row's usage numbers ARE
                  // the persisted breaker state (see maybeAutoCompactAfterTurn).
                  yield* completeTask({
                    status: "completed",
                    tone: "warning",
                    usage,
                    summary: `Compaction barely reduced the context ${numbers}. Auto-compaction disabled.`,
                    detail: COMPACTION_ADVICE_DETAIL,
                  });
                  return;
                }
                if (
                  outcome.preTokens - outcome.postTokens <
                  outcome.preTokens * COMPACT_MIN_GAIN_PRE_FRACTION
                ) {
                  // Ineffective below the gate: warn + advise; auto-compact
                  // stays armed — only the gate above disarms.
                  yield* completeTask({
                    status: "completed",
                    tone: "warning",
                    usage,
                    summary: `Compaction did not reduce the context ${numbers}.`,
                    detail: COMPACTION_ADVICE_DETAIL,
                  });
                  return;
                }
                yield* completeTask({
                  status: "completed",
                  usage,
                  summary: `Compaction succeeded ${numbers}.`,
                });
              }),
          }),
          // onExit (not ensuring): also runs on INTERRUPTION, where neither
          // match branch executed — without this the row would dangle open and
          // keep send blocked until the boot sweep.
          Effect.onExit(() =>
            Effect.gen(function* () {
              ctx.hiddenCompressActive = false;
              if (compactionRowClosed) return;
              yield* completeTask({ status: "stopped", summary: "Compaction interrupted." });
            }),
          ),
        );

        // ru-code: a CONFIRMED compression retires the session — qwen 0.13.1's
        // live ACP session keeps its pre-compress chat, so keeping it alive
        // makes the /compress cosmetic (the meter drops, the model still gets
        // the full history). The compression IS in the session file; ending the
        // session here means the next action recovers via `session/load` (same
        // sessionId) and rebuilds the chat COMPRESSED. Recovery is the existing
        // `allowRecovery` path every turn already takes after a stop. Inline is
        // safe: this is a request fiber, not a session-bound fiber, and no turn
        // is active (guarded above). Failed/unconfirmed compressions keep the
        // session — nothing changed worth restarting for.
        if (compressionConfirmed) {
          yield* abortSession(ctx, COMPACTION_RESTART_METHOD);
        }
      });

    // Auto-compact trigger — evaluated at the END of each successful turn
    // (sendTurn forks it AFTER finalize so the turn's own result is never
    // delayed). Failures are logged and swallowed; every bail reason gets a
    // debug line — a silently idle auto-compact is undiagnosable in the field.
    const maybeAutoCompactAfterTurn = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const bail = (reason: string, extra?: Record<string, unknown>) =>
          Effect.logDebug("[cli-adapter] auto-compact skipped", { threadId, reason, ...extra });
        const getAutoCompactContext = options?.getAutoCompactContext;
        if (!getAutoCompactContext) return yield* bail("no-settings-getter");
        const ctx = sessions.get(threadId);
        if (!ctx) return yield* bail("no-session-ctx");
        if (ctx.stopped) return yield* bail("session-stopped");
        if (ctx.hiddenCompressActive) return yield* bail("compress-active");
        const usedTokens = ctx.lastEmittedUsedTokens;
        if (usedTokens === undefined || usedTokens <= 0) return yield* bail("no-usage-signal");
        const windowTokens = yield* currentContextWindowTokens(ctx);
        if (usedTokens < windowTokens * AUTO_COMPACT_USED_FRACTION) {
          return yield* bail("below-threshold", { usedTokens, windowTokens });
        }
        // Circuit breaker, derived from persisted history (survives restarts):
        // disarmed while the LAST completed compaction left usage at/above the
        // disarm line and usage has not dipped below it since.
        const getThreadCompactionState = options?.getThreadCompactionState;
        if (getThreadCompactionState) {
          const compactionState = yield* getThreadCompactionState(threadId);
          if (isAutoCompactDisarmed(compactionState, windowTokens * AUTO_COMPACT_DISARM_FRACTION)) {
            return yield* bail("breaker-disarmed", { usedTokens, windowTokens });
          }
        }
        if (!(yield* getAutoCompactContext)) return yield* bail("setting-off");
        yield* Effect.logDebug("[cli-adapter] auto-compact triggered", {
          threadId,
          usedTokens,
          windowTokens,
        });
        yield* compactContext(threadId);
      }).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("[cli-adapter] auto-compact failed", { threadId, cause }),
        ),
        Effect.ignore,
      );

    const respondToRequest: QwenAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("cli-adapter.approval.respond.received", {
          threadId,
          requestId,
        });
        const ctx = yield* requireSession(threadId);
        // ru-code: the parked requestPermission callback resumes synchronously on
        // resolution and derives the plan-approval optionId from the resolved
        // DECISION itself (proceed_always on acceptForSession, else proceed_once —
        // see Branch 2 of the requestPermission chain above), so an approve-time
        // full-access toggle rides that decision and no runtimeMode-mirror refresh
        // is needed on this path.
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          yield* Effect.logDebug("cli-adapter.approval.respond.unknown", {
            threadId,
            requestId,
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            // ru-code: kept English — ProviderCommandReactor substring-matches
            // this detail to trigger the stale-pending-request fast-path.
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        // Plan-approval and tool/file approval both resolve through
        // `pendingApprovals` with the same `ProviderApprovalDecision`
        // response shape — `pending.kind === "exit_plan_mode"` is the
        // only distinguishing signal. Split the log label so the
        // structured timeline stays readable; the failure activity
        // kind (`provider.approval.respond.failed`) remains unified
        // on the wire so the web treats both identically.
        const isPlanApproval = pending.kind === "exit_plan_mode";
        const kind: AcpPendingKind = isPlanApproval ? "plan-approval" : "approval";
        const labelStem = isPlanApproval ? "cli-adapter.plan-approval" : "cli-adapter.approval";
        yield* settleAndDelete({
          requestId,
          kind,
          threadId,
          map: ctx.pendingApprovals,
          deferred: pending.decision,
          value: decision,
          label: `${labelStem}.respond`,
        });
      });

    const respondToUserInput: QwenAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("cli-adapter.user-input.respond.received", {
          threadId,
          requestId,
        });
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          yield* Effect.logDebug("cli-adapter.user-input.respond.unknown", {
            threadId,
            requestId,
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            // ru-code: kept English — ProviderCommandReactor substring-matches
            // this detail to trigger the stale-pending-request fast-path.
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        // Settle the Deferred AND delete the map entry in one shot —
        // keeping the map in sync with reality the moment we commit a
        // response.
        yield* settleAndDelete({
          requestId,
          kind: "user-input",
          threadId,
          map: ctx.pendingUserInputs,
          deferred: pending.answers,
          value: answers,
          label: "cli-adapter.user-input.respond",
        });
      });

    const readThread: QwenAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: QwenAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer ≥ 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: QwenAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* abortSession(ctx, MAINTENANCE_METHOD);
        }),
      );

    const listSessions: QwenAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: QwenAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const hasParkedRequests: NonNullable<QwenAdapterShape["hasParkedRequests"]> = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        if (c === undefined || c.stopped) return false;
        return c.pendingApprovals.size > 0 || c.pendingUserInputs.size > 0;
      });

    // ru-code (warm engine): coordinated teardown (acp-process-pool §2.5) —
    // driven entirely by in-memory state, bounded by ONE shared grace:
    //   1. in parallel, instantly: SIGKILL every session with no in-flight
    //      prompt (classic inline path) and every warm slot (pool drain);
    //   2. simultaneously: settle every active turn instantly (cancel sent,
    //      turn.completed → session.exited, zero waiting on the process);
    //   3. one shared deadline min(all active children exited, grace), then
    //      parallel SIGKILL + scope close.
    // Worst case ≈ cancelGraceMs + ε, and only when turns are running; an
    // idle shutdown is as instant as today. When it returns, every child this
    // adapter spawned is dead and every scope closed (journal drained).
    const stopAllWarm = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const contexts = Array.from(sessions.values()).filter((ctx) => !ctx.stopped);
        const instantKill: QwenSessionContext[] = [];
        const activeTurn: QwenSessionContext[] = [];
        for (const ctx of contexts) {
          if (
            ctx.activeTurnId !== undefined &&
            ctx.activePromptFiber !== undefined &&
            !ctx.childExitObserved
          ) {
            activeTurn.push(ctx);
          } else {
            instantKill.push(ctx);
          }
        }
        // Sessions THIS stopAll claimed (check-and-set of `ctx.stopped` is one
        // synchronous step, so a racing single stop and this batch settle each
        // session exactly once) — the batch tail kills and latch-resolves ONLY
        // its own claims; a single-stop claim is finished by its own detached
        // teardown. The WHOLE body runs under an uninterruptibility mask (an
        // interrupted stopAll RPC would otherwise strand claimed latches with
        // children never killed — bricking those threads forever); only the
        // shared grace wait below is restored, with its kill tail on onExit.
        const claimed: {
          readonly ctx: QwenSessionContext;
          readonly latch: Deferred.Deferred<void>;
        }[] = [];
        const settleActive = Effect.forEach(
          activeTurn,
          (ctx) =>
            Effect.gen(function* () {
              if (ctx.stopped) return; // a racing single stop owns this teardown
              ctx.stopped = true;
              // Same-thread restart protection as the single-stop path: an
              // immediate re-send must await the old child's death before
              // session/load re-reads the JSONL it may still be appending.
              const latch = yield* Deferred.make<void>();
              teardownLatches.set(ctx.threadId, latch);
              claimed.push({ ctx, latch });
              yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
              yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
              // ru-code (P2 zombie settle): stopAll's fast path bypasses
              // abortSession/abortSessionTeardown entirely, so it needs its
              // own call — before settleActiveTurnForTeardown interrupts the
              // notification fiber.
              yield* settleOpenSubAgentAsStopped(ctx);
              yield* settleActiveTurnForTeardown(ctx, MAINTENANCE_METHOD);
            }),
          { concurrency: "unbounded", discard: true },
        );
        const killInstant = Effect.forEach(
          instantKill,
          // Forced classic inline kill: even if a prompt fiber appeared
          // between the partition above and this call, a detached grace
          // teardown here would let that child outlive stopAll's
          // "everything dead on return" contract.
          (ctx) => abortSession(ctx, MAINTENANCE_METHOD, { disallowDetachedTeardown: true }),
          { concurrency: "unbounded", discard: true },
        );
        const drainSlots = warmPool !== undefined ? warmPool.drainAll : Effect.void;
        yield* Effect.all([settleActive, killInstant, drainSlots], {
          concurrency: "unbounded",
          discard: true,
        });
        if (claimed.length > 0) {
          // ONE shared grace for the whole fleet — cancelled agents get up to
          // cancelGraceMs total (not each) to reap children and flush files.
          // The grace wait is the only RESTORED (interruptible) region; its
          // kill+close+latch tail rides `Effect.onExit`, so an interrupted
          // stopAll RPC mid-grace still kills and releases everything.
          yield* restore(
            Effect.race(
              Effect.forEach(claimed, (entry) => entry.ctx.acp.waitForExit, {
                concurrency: "unbounded",
                discard: true,
              }),
              Effect.sleep(Duration.millis(cancelGraceMs)),
            ),
          ).pipe(
            Effect.onExit(() =>
              Effect.forEach(claimed, (entry) => finishSessionTeardown(entry.ctx, entry.latch), {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          );
        }
      }),
    );

    const stopAllClassic = Effect.suspend(() =>
      Effect.forEach(sessions.values(), (ctx) => abortSession(ctx, MAINTENANCE_METHOD), {
        discard: true,
      }),
    );

    const stopAll: QwenAdapterShape["stopAll"] = () => (warmEngine ? stopAllWarm : stopAllClassic);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        adapterClosing = true;
      }).pipe(
        Effect.andThen(warmEngine ? stopAllWarm : stopAllClassic),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      // Cli Code's model is bundled inside the CLI; T3 doesn't pick a
      // model. Declaring `in-session` (rather than `unsupported`) tells the
      // reactor not to restart the session when a turn arrives with a
      // different `model` slug than the session recorded — that mismatch
      // would otherwise nuke the ACP session every turn and wipe history.
      // ru-code: supportsInSessionRuntimeMode lets the reactor apply a runtime-mode
      // change via per-turn setMode (sendTurn refreshes ctx.currentRuntimeMode from
      // input.runtimeMode) instead of respawning the ACP session.
      capabilities: { sessionModelSwitch: "in-session", supportsInSessionRuntimeMode: true },
      startSession,
      sendTurn,
      interruptTurn,
      compactContext, // ru-code
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      hasParkedRequests,
      stopAll,
      streamEvents,
    } satisfies QwenAdapterShape;
  });
}
