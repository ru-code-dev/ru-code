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
import { CONTEXT_COMPACTION_TASK_PREFIX, QWEN_KIND } from "@ru-code/branding";
import {
  ApprovalRequestId,
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
  ACP_SESSION_START_TIMEOUT_MS,
  AUTO_COMPACT_DISARM_FRACTION,
  COMPACT_MIN_GAIN_PRE_FRACTION,
  COMPACTION_RESTART_METHOD,
  AUTO_COMPACT_USED_FRACTION,
  MAINTENANCE_METHOD,
  MODE_CHANGE_METHOD,
  QWEN_MODELS_AUTO_DISCOVERY,
  STOP_BUTTON_METHOD,
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
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // ru-code: the adapter-layer scope. Session-bound fibers (child-exit
    // watcher) fork their teardown onto THIS scope via `scheduleTeardown` so
    // `abortSession` runs on a fresh fiber — never the watcher's own fiber.
    // Running it inline there would self-interrupt (`abortSession` interrupts
    // those very fibers), aborting the teardown before it offers
    // `session.exited`.
    const layerScope = yield* Effect.scope;

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
    const abortSession = (ctx: QwenSessionContext, method: AbortMethod) =>
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

        // end-graceful or end-force: full teardown.
        if (ctx.stopped) {
          yield* Effect.logDebug("[cli-adapter] ACP session abort skipped (already stopped)", {
            threadId: ctx.threadId,
            method,
          });
          return;
        }
        ctx.stopped = true;

        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);

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
          yield* Deferred.await(ctx.turnFinalized);
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

    const startSession: QwenAdapterShape["startSession"] = (input) =>
      withThreadLock(
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

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            // ru-code: a mid-turn restart (model/cwd change) is a cancel, not a
            // failure — flag it so the old turn's finalizer labels it cancelled.
            existing.userCancelRequested = true;
            yield* abortSession(existing, MODE_CHANGE_METHOD);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: QwenSessionContext;

          const resumeSessionId = parseQwenResume(input.resumeCursor)?.sessionId;

          // ru-code: MCP overlay is a separate, out-of-scope feature — the port's
          // start input carries no overlay fields, so no overlay is supplied.
          const settingsOverlay = undefined;

          const acp = yield* makeQwenAcpRuntime({
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
              event.status === "failed" && !(event.cause && Cause.hasInterruptsOnly(event.cause))
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
            Effect.mapError((error) => remapStartFailureThroughClassifier("session/start", error)),
          );

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

                // Branch 1 — ask_user_question: surface as a structured
                // user-input request the existing Cursor/OpenCode UI handles.
                const toolName = readToolName(params);
                const questionsPayload = readAskQuestionsPayload(params);
                if (toolName === "ask_user_question" || questionsPayload) {
                  if (!questionsPayload) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const { questions, questionIndexById } = normalizeQwenQuestions(questionsPayload);
                  const requestId = ApprovalRequestId.make(yield* cryptoUuid);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
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
            return yield* acp.start();
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
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
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
                  case "UsageUpdated": {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
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
        }).pipe(Effect.scoped),
      );

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
                  taskId: RuntimeTaskId.make(turnId),
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

          const result = yield* ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
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
                          taskId: RuntimeTaskId.make(turnId),
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
              payload: { taskId, ...payload },
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
          payload: { taskId, description: "Compacting context…" },
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

    const stopAll: QwenAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), (ctx) => abortSession(ctx, MAINTENANCE_METHOD), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (ctx) => abortSession(ctx, MAINTENANCE_METHOD), {
        discard: true,
      }).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
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
