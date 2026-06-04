/**
 * CliAdapterLive — Cli Code CLI (`CLI --acp`) via ACP.
 *
 * Modelled closely after CursorAdapter: spawns an ACP child process, maps
 * session update events into canonical T3 runtime events, and supports
 * permission-request / user-input flows through deferred resolution.
 *
 * @module CliAdapterLive
 */
import { CLI_NAME } from "@ru-fork/branding";
import {
  type AbortMethod,
  ApprovalRequestId,
  type CliSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ACP_WIRE_STALL_KILL_MS,
  ACP_WIRE_STALL_WARN_MS,
  CONTEXT_WINDOW_TOKENS,
  MAINTENANCE_METHOD,
  MODE_CHANGE_METHOD,
  POST_ANSWER_RESUME_TIMEOUT_MS,
  ServerConfig,
  SLASH_COMMAND_NOTIFICATION_METHODS,
  STOP_BUTTON_METHOD,
} from "../../config.ts";
import {
  buildPostAnswerResumeProbe,
  settleAndDelete,
  type AcpPendingKind,
} from "./AcpPendingRequests.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  decisionToPermissionKind,
  findPermissionOptionIdByKind,
  mapAcpToAdapterError,
} from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeCliAcpRuntime } from "./CliAcpSupport.ts";
import { type CliAdapterShape } from "../Services/CliAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
// ru-fork: subagent picker biases CLI toward the Agent tool by
// injecting a system-reminder when the user text contains `agent:name`.
import { prependSubagentReminderIfNeeded } from "../../ru-fork/subagents/userTextSubagentReminder.ts";
// ru-fork: classifier for cli-side errors — routes recognized
// failures to the right UI surface. See
// `ru-fork-instrumental/changes/server-errors-handaling.md`.
import { classify, UNRECOGNIZED_DECISION } from "../../ru-fork/cli-errors-handling/recognizers.ts";
import { cliErrorFields } from "../../ru-fork/cli-errors-handling/dispatch.ts";
import {
  describeRequestFailure,
  describeRequestPayload,
} from "../../ru-fork/cli-errors-handling/requestLogFormat.ts";

const PROVIDER = ProviderDriverKind.make(CLI_NAME);

export interface CliAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
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

interface WireActivityState {
  lastIncomingAt: number;
  stallWarned: boolean;
}

interface CliSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  childExitFiber: Fiber.Fiber<void, never> | undefined;
  stallWatchdogFiber: Fiber.Fiber<void, never> | undefined;
  readonly wireActivity: WireActivityState;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  // ru-fork: resolved by sendTurn's finalizer the instant it offers the
  // turn's single `turn.completed`. `abortSession` awaits this (when a turn
  // is active) before offering `session.exited`, so `turn.completed` is
  // always ingested first (I5: ingestion strips the per-turn assistant cache
  // on `session.exited`; finalizing the message after that strip would leave
  // the bubble timer stuck forever). Replaced per turn in `sendTurn`.
  turnFinalized: Deferred.Deferred<void> | undefined;
  // ru-fork: set true by the cancel-INTENT teardown sites (the Stop button
  // via `interruptTurn`, and the mode-change teardown in `startSession`)
  // BEFORE the force-kill. The finalizer reads it to label the turn
  // `cancelled` (not a transport `failed`) — deterministic because it is set
  // before the kill that fails the in-flight prompt. Other teardowns
  // (maintenance/stall/probe/child-exit) leave it false so the turn keeps its
  // real failure label. Reset to false at the start of each `sendTurn`.
  userCancelRequested: boolean;
  stopped: boolean;
  // ru-fork: live runtimeMode mirror. Refreshed by sendTurn and
  // respondToRequest from their per-call inputs. Read by the cli-initiated
  // requestPermission callback (plan-approval optionId and full-access
  // short-circuit) which has no per-call input of its own.
  currentRuntimeMode: RuntimeMode;
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

interface CliAskQuestionRaw {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly multiSelect?: boolean;
}

interface CliAskQuestionsPayload {
  readonly questions: ReadonlyArray<CliAskQuestionRaw>;
}

interface CliExitPlanPayload {
  readonly plan: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ru-fork: empty-stream and other RPC recognizers moved to
// `apps/server/src/ru-fork/cli-errors-handling/recognizers.ts`.
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
): CliAskQuestionsPayload | undefined {
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
  return { questions: questions as ReadonlyArray<CliAskQuestionRaw> };
}

// Detection only — used by the diagnostic log so we can tell whether a
// generic-approval permission request was actually `exit_plan_mode` carrying
// a plan markdown. No early-return / no special handling: the request still
// flows through the generic approval path so the user gets Cli's native
// proceed/cancel dialog.
function readExitPlanPayload(
  params: EffectAcpSchema.RequestPermissionRequest,
): CliExitPlanPayload | undefined {
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

function cliQuestionId(index: number, header: string): string {
  return `cli-q${index}-${slugifyHeader(header)}`;
}

interface NormalizedCliQuestions {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly questionIndexById: ReadonlyMap<string, number>;
}

function normalizeCliQuestions(payload: CliAskQuestionsPayload): NormalizedCliQuestions {
  const questionIndexById = new Map<string, number>();
  const questions = payload.questions.map((entry, index) => {
    const id = cliQuestionId(index, entry.header);
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
function encodeCliAnswersForPermission(
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

function selectCliSubmitOptionId(params: EffectAcpSchema.RequestPermissionRequest): string {
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

// ru-fork: maps the two composer dropdowns onto cli-code's ApprovalMode
// enum (cli-code/packages/core/src/config/config.ts:148-191). `plan` wins
// over runtimeMode so the runtimeMode value is preserved in ru-fork state
// and re-applies when the user leaves plan. full-access maps to "auto-edit"
// (not "yolo") because yolo bypasses CLI's L4 PermissionManager rules
// (Session.ts:651-656); anything still ask-default under auto-edit is caught
// by the server-side short-circuit in the requestPermission handler.
type CliWireMode = "plan" | "default" | "auto-edit";

function resolveCliMode(input: {
  readonly interactionMode: "plan" | "default" | undefined;
  readonly runtimeMode: RuntimeMode;
}): CliWireMode {
  if (input.interactionMode === "plan") return "plan";
  if (input.runtimeMode === "auto-accept-edits") return "auto-edit";
  if (input.runtimeMode === "full-access") return "auto-edit";
  return "default";
}

const CLI_RESUME_VERSION = 1 as const;

interface CliResumeCursor {
  readonly schemaVersion: typeof CLI_RESUME_VERSION;
  readonly sessionId: string;
}

function parseCliResume(raw: unknown): { sessionId: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<CliResumeCursor>;
  if (candidate.schemaVersion !== CLI_RESUME_VERSION) return undefined;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()) return undefined;
  return { sessionId: candidate.sessionId.trim() };
}

export function makeCliAdapter(cliSettings: CliSettings, options?: CliAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(CLI_NAME);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger = options?.nativeEventLogger ?? undefined;

    const sessions = new Map<ThreadId, CliSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // ru-fork: the adapter-layer scope. Session-bound fibers (child-exit
    // watcher, stall watchdog, post-answer-resume probe) fork their teardown
    // onto THIS scope via `scheduleTeardown` so `abortSession` runs on a fresh
    // fiber — never the watcher's own fiber. Running it inline there would
    // self-interrupt (`abortSession` interrupts those very fibers), aborting
    // the teardown before it offers `session.exited`.
    const layerScope = yield* Effect.scope;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

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
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
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
    ): Effect.Effect<CliSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /**
     * End an ACP session using one of the four strategies in AbortMethod
     * (see contracts/providerRuntime). Picking the right method per call
     * site is how we balance cleanup vs hang-resistance:
     *
     *   "cancel-turn"
     *     ACP `session/cancel` only. Session, child process, and
     *     conversation context all survive. Use when the agent honours
     *     cancel reliably.
     *
     *   "reset-session"  [TODO — NOT IMPLEMENTED]
     *     Drop the ACP session_id and create a new one in the SAME child
     *     process. Cheaper than end-graceful because the CLI child + MCP
     *     subprocesses are kept alive. Requires splitting child-process
     *     scope from session-state scope (currently they are the same).
     *     Throws today; will be wired once that refactor lands.
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
    const abortSession = (ctx: CliSessionContext, method: AbortMethod) =>
      Effect.gen(function* () {
        if (method === "reset-session") {
          return yield* Effect.die(
            new Error(
              "abortSession('reset-session') is not implemented yet — requires splitting child-process scope from session-state scope.",
            ),
          );
        }

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
          yield* Effect.logInfo("[cli-adapter] ACP session abort skipped (already stopped)", {
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
        // Same for the child-exit and stall-watchdog fibers — they're
        // tied to this session's lifetime and must die with it.
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        if (ctx.childExitFiber) {
          yield* Fiber.interrupt(ctx.childExitFiber);
        }
        if (ctx.stallWatchdogFiber) {
          yield* Fiber.interrupt(ctx.stallWatchdogFiber);
        }

        if (method === "end-force") {
          // SIGKILL — kernel reaps the child unconditionally, so the
          // spawn finalizer's child.exited promise resolves immediately
          // and the subsequent Scope.close completes without waiting.
          // It also makes any in-flight `acp.prompt()` fail (transport EOF),
          // which drives sendTurn's finalizer below.
          yield* ctx.acp.forceKill;
        }

        // ru-fork: SINGLE-WRITER ordering barrier. If a turn is in flight, the
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

    // ru-fork: run `abortSession` on a fresh fiber in the adapter-layer scope.
    // Used by the session-bound fibers (child-exit watcher, stall watchdog,
    // post-answer-resume probe), which must NOT call `abortSession` inline:
    // `abortSession` interrupts those very fibers, so an inline call would
    // self-interrupt and never reach `session.exited`. Forking onto the layer
    // scope decouples the teardown from the fiber that triggered it.
    const scheduleTeardown = (ctx: CliSessionContext, method: AbortMethod) =>
      abortSession(ctx, method).pipe(Effect.forkIn(layerScope), Effect.asVoid);

    const startSession: CliAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Ожидался провайдер '${PROVIDER}', получен '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Не указан рабочий каталог (cwd).",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            // ru-fork: a mid-turn restart (model/cwd change) is a cancel, not a
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
          let ctx!: CliSessionContext;

          const resumeSessionId = parseCliResume(input.resumeCursor)?.sessionId;

          // Captured by the protocolLogging.logger closure below and
          // by the stall watchdog fiber after ctx is built. Set before
          // makeCliAcpRuntime so the very first incoming frame from
          // CLI has a valid baseline.
          const wireActivity: WireActivityState = {
            lastIncomingAt: yield* Clock.currentTimeMillis,
            stallWarned: false,
          };

          const acp = yield* makeCliAcpRuntime({
            cliSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            // ru-fork: resolved cli.js — spawned as `node <cliJs> --acp` directly.
            cliJs: serverConfig.cliJs,
            cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(resumeSessionId ? { resumeSessionId } : {}),
            protocolLogging: {
              logger: (event) =>
                Effect.gen(function* () {
                  if (event.direction === "incoming") {
                    wireActivity.lastIncomingAt = yield* Clock.currentTimeMillis;
                    wireActivity.stallWarned = false;
                  }
                }),
            },
            // ru-fork: log every failed RPC at error level with the pretty-
            // printed Cause. This is the only triage breadcrumb we keep after
            // the empty-stream investigation — it's failure-only (no noise on
            // healthy turns) and contains everything we need to identify a new
            // class of cli-side error without re-enabling wire dumps.
            //
            // Cause.hasInterruptsOnly filters out cancellations (user clicks
            // Stop, session torn down, post-answer-resume timeout, supersede).
            // Those are deliberate teardowns, not errors — logging them as
            // "request.failed" was just noise.
            requestLogger: (event) =>
              event.status === "failed" && !(event.cause && Cause.hasInterruptsOnly(event.cause))
                ? Effect.logError("[cli-acp.request.failed]", {
                    threadId: input.threadId,
                    method: event.method,
                    payload: describeRequestPayload(event.payload),
                    ...(event.cause ? describeRequestFailure(event.cause) : {}),
                  })
                : Effect.void,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            // ru-fork: capture the original stream-side cause at the
            // boundary — `mapAcpToAdapterError` below wraps it in a
            // `ProviderAdapterProcessError` whose `.cause` is preserved
            // but whose pretty-printed `Cause` chain in higher-level
            // handlers loses the original frames. Logging here keeps the
            // root cause grep-able under a stable tag.
            Effect.tapError((cause) =>
              Effect.logError("[cli-acp.stream-error]", {
                threadId: input.threadId,
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
          );

          const started = yield* Effect.gen(function* () {
            // ru-fork: catch every CLI vendor extension notification.
            // Always log the raw payload so unknown methods surface.
            // For slash-command progress + result notifications (compress,
            // summary, ...), synthesise a `content.delta` event so the text
            // lands in the active turn's assistant bubble — same pipeline
            // real `agent_message_chunk` text uses. Method name varies by
            // CLI vendor build; the accepted set of vendor namespaces lives
            // in `SLASH_COMMAND_NOTIFICATION_METHODS` (centralized in
            // `@ru-fork/branding`). See
            // `ru-fork-instrumental/changes/cli-events.md`.
            yield* acp.handleUnknownExtNotification((method, params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, method, params, "acp.jsonrpc");
                yield* Effect.logDebug("[cli-acp] ext notification received", {
                  threadId: input.threadId,
                  method,
                  params,
                });

                if (!SLASH_COMMAND_NOTIFICATION_METHODS.includes(method)) return;

                const rawMessage = (params as { message?: unknown })?.message;
                const message = typeof rawMessage === "string" ? rawMessage : "";
                if (message.length === 0) return;

                const messageType = (params as { messageType?: unknown })?.messageType;
                const text = messageType === "error" ? `❌ ${message}\n` : `${message}\n`;

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

                // Branch 1 — ask_user_question: surface as a structured
                // user-input request the existing Cursor/OpenCode UI handles.
                const toolName = readToolName(params);
                const questionsPayload = readAskQuestionsPayload(params);
                if (toolName === "ask_user_question" || questionsPayload) {
                  if (!questionsPayload) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const { questions, questionIndexById } = normalizeCliQuestions(questionsPayload);
                  const requestId = ApprovalRequestId.make(crypto.randomUUID());
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
                  const encodedAnswers = encodeCliAnswersForPermission(
                    collectedAnswers,
                    questionIndexById,
                  );
                  if (Object.keys(encodedAnswers).length === 0) {
                    return { outcome: { outcome: "cancelled" as const } };
                  }
                  const submitOptionId = selectCliSubmitOptionId(params);
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
                // until the user reacts (clicks Реализовать, sends a refining
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
                  const requestId = ApprovalRequestId.make(crypto.randomUUID());
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision, kind: "exit_plan_mode" });
                  // Surface the held-open RPC as a plan_approval request so the
                  // projection knows Cli is parked waiting for a plan decision.
                  // The UI keys off `hasPendingPlanApproval` to flip from
                  // "Работает" → "План готов" and stop the streaming timer.
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
                  // ru-fork: optionId controls CLI's approvalMode for the
                  // SAME-turn implementation that runs immediately after plan
                  // accept (cli-code/packages/core/src/tools/exitPlanMode.ts
                  // :96-118 — onConfirm mutates ApprovalMode synchronously
                  // before returning). The per-turn setMode is too late for
                  // that same-turn work. Read ctx.currentRuntimeMode (just
                  // refreshed by respondToRequest from its input.runtimeMode)
                  // so any runtimeMode that resolves to "auto-edit" also gets
                  // it here via CLI's built-in proceed_always → AUTO_EDIT path.
                  //   full-access       → proceed_always → CLI AUTO_EDIT
                  //   auto-accept-edits → proceed_always → CLI AUTO_EDIT
                  //   approval-required → proceed_once   → CLI DEFAULT
                  const currentRuntimeMode = ctx.currentRuntimeMode;
                  const approveOptionId: "proceed_once" | "proceed_always" =
                    currentRuntimeMode === "full-access" ||
                    currentRuntimeMode === "auto-accept-edits"
                      ? "proceed_always"
                      : "proceed_once";
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

                // ru-fork: read live runtimeMode from ctx — refreshed on
                // every sendTurn / respondToRequest. input.runtimeMode from the
                // startSession closure is fine at session start but goes stale
                // once the user toggles the dropdown (no session restart now).
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
                const requestId = ApprovalRequestId.make(crypto.randomUUID());
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
                  yield* Effect.logWarning(
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
            // ru-fork: capture the CLI exit code at the boundary —
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
              schemaVersion: CLI_RESUME_VERSION,
              sessionId: started.sessionId,
            } satisfies CliResumeCursor,
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
            stallWatchdogFiber: undefined,
            wireActivity,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            turnFinalized: undefined,
            userCancelRequested: false,
            stopped: false,
            // ru-fork: seed the live runtimeMode mirror from startSession
            // input (the orchestrator passes thread.runtimeMode here). Future
            // sendTurn / respondToRequest calls refresh it.
            currentRuntimeMode: input.runtimeMode,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
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
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
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
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                      payload: {
                        usage: {
                          usedTokens: event.used,
                          maxTokens: CONTEXT_WINDOW_TOKENS,
                        },
                      },
                    });
                    return;
                  }
                }
              }),
            ),
          ).pipe(Effect.forkChild);

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
            // ru-fork: schedule (don't inline) — see scheduleTeardown. If a
            // turn was active, the child's death already failed its prompt into
            // the finalizer; abortSession awaits that turn.completed before
            // session.exited. If idle, this is plain cleanup. Covers B1
            // (process-exit, killAcp:false) which the reactor won't tear down.
            yield* scheduleTeardown(ctx, MAINTENANCE_METHOD);
          }).pipe(Effect.forkChild);
          ctx.childExitFiber = childExitFiber;

          // Layer B — wire-stall watchdog. Polls every second while a
          // turn is active and compares now to the last incoming ACP
          // frame timestamp (updated by the protocolLogging.logger
          // closure above). At the warn threshold logs once; at the
          // kill threshold force-aborts the session.
          //
          // Suspended while CLI is parked on an approval / plan-
          // approval / user-input request: those are legitimate
          // silences (CLI is waiting on us, not stuck), and the user
          // may take minutes to respond.
          const stallWatchdogFiber = yield* Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep("1 seconds");
              if (ctx.stopped) return;
              const parkedOnUser = ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0;
              if (ctx.activeTurnId === undefined || parkedOnUser) {
                // No active turn, or CLI is parked waiting on the
                // user. Keep the baseline fresh so the first frame
                // after the user responds isn't measured against an
                // old timestamp.
                ctx.wireActivity.lastIncomingAt = yield* Clock.currentTimeMillis;
                ctx.wireActivity.stallWarned = false;
                continue;
              }
              const elapsed = (yield* Clock.currentTimeMillis) - ctx.wireActivity.lastIncomingAt;
              if (elapsed >= ACP_WIRE_STALL_KILL_MS) {
                yield* Effect.logError(
                  "[cli-adapter] ACP wire stalled past kill threshold; aborting session",
                  {
                    threadId: ctx.threadId,
                    activeTurnId: ctx.activeTurnId,
                    elapsedMs: elapsed,
                    killThresholdMs: ACP_WIRE_STALL_KILL_MS,
                  },
                );
                // ru-fork: schedule (don't inline) — see scheduleTeardown. The
                // force-kill inside abortSession fails the wedged prompt into
                // the finalizer (standard mid-turn failure, classified C4).
                yield* scheduleTeardown(ctx, MAINTENANCE_METHOD);
                return;
              }
              if (elapsed >= ACP_WIRE_STALL_WARN_MS && !ctx.wireActivity.stallWarned) {
                ctx.wireActivity.stallWarned = true;
                yield* Effect.logWarning("[cli-adapter] ACP wire stalled past warn threshold", {
                  threadId: ctx.threadId,
                  activeTurnId: ctx.activeTurnId,
                  elapsedMs: elapsed,
                  warnThresholdMs: ACP_WIRE_STALL_WARN_MS,
                  killThresholdMs: ACP_WIRE_STALL_KILL_MS,
                });
              }
            }
          }).pipe(Effect.forkChild);
          ctx.stallWatchdogFiber = stallWatchdogFiber;

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

    const sendTurn: CliAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // ru-fork: turnId + turn.started are the genuine FIRST acts — emitted
        // BEFORE requireSession — so EVERY exit from this turn (a requireSession
        // / D2 failure, a validation / D1 failure, a prompt failure, a defect,
        // or success) is finalized into exactly one `turn.completed` by the
        // onExit finalizer below. That finalizer is the SINGLE source of the
        // failed-turn event: it carries the classified text + surface (so
        // ingestion is the single writer of timeline row / banner / message-
        // finalize) and the real turnId (never a projection read). No `ctx` is
        // needed to emit — `finalized` is a local first-wins flag and the
        // threadId/turnId are local.
        const turnId = TurnId.make(crypto.randomUUID());
        let finalized = false;
        let activeCtx: CliSessionContext | undefined;
        const turnFinalized = yield* Deferred.make<void>();

        const finalize = (payload: {
          readonly state: "completed" | "cancelled" | "failed";
          readonly stopReason: string | null;
          readonly errorMessage?: string;
          readonly showNotification?: boolean;
        }) =>
          Effect.gen(function* () {
            if (finalized) return; // check-and-set, no yield between ⇒ atomic
            finalized = true;
            if (activeCtx) activeCtx.activeTurnId = undefined; // stop the stall watchdog
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
            : Effect.suspend(() => {
                const error = cause.reasons.find(Cause.isFailReason)?.error;
                // ru-fork: classification must NEVER gate the single-writer emit — a
                // throw here would silence the turn AND hang teardown (turnFinalized
                // never resolves). Fall back to the generic decision on any throw.
                const decision = (() => {
                  try {
                    return classify(error, cause) ?? UNRECOGNIZED_DECISION;
                  } catch {
                    return UNRECOGNIZED_DECISION;
                  }
                })();
                // Emit FIRST (the one critical write), THEN log the `[runtime]`
                // breadcrumb best-effort: built lazily inside Effect.sync so a throw in
                // describeRequestFailure can't gate the emit, and `ignore`d so a log
                // failure can't fail the finalizer. The turn is finalized either way.
                return finalize({
                  state: "failed",
                  stopReason: "failed",
                  ...(decision.text !== undefined ? { errorMessage: decision.text } : {}),
                  showNotification: decision.surface === "T+N",
                }).pipe(
                  Effect.andThen(
                    Effect.sync(() => ({
                      source: "cli",
                      where: "turn",
                      threadId: input.threadId,
                      ...cliErrorFields(decision, describeRequestFailure(cause)),
                    })).pipe(
                      Effect.flatMap((fields) => Effect.logError("[runtime]", fields)),
                      Effect.ignore,
                    ),
                  ),
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
          activeCtx = ctx;
          ctx.activeTurnId = turnId;
          ctx.turnFinalized = turnFinalized;
          ctx.userCancelRequested = false;
          // Reset the wire-stall baseline at the start of each turn so
          // the watchdog measures inactivity within this turn only.
          ctx.wireActivity.lastIncomingAt = yield* Clock.currentTimeMillis;
          ctx.wireActivity.stallWarned = false;
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            // ru-fork: prepend the subagent system-reminder when the
            // text contains an `agent:name` chip token; see helper for why.
            const subagentReminder = prependSubagentReminderIfNeeded(input.input.trim());
            if (subagentReminder.applied) {
              yield* Effect.logDebug("[cli-adapter] subagent system-reminder applied", {
                threadId: input.threadId,
              });
            }
            promptParts.push({ type: "text", text: subagentReminder.text });
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
                  detail: `Неверный идентификатор вложения '${attachment.id}'.`,
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
              issue: "Сообщение должно содержать текст или вложения.",
            });
          }

          // ru-fork: refresh the live runtimeMode mirror so the
          // cli-initiated requestPermission callback (plan-approval optionId,
          // full-access short-circuit) reads the current dropdown value, not
          // whatever was captured at session start.
          ctx.currentRuntimeMode = input.runtimeMode;
          // ru-fork: resolve both composer dropdowns (interactionMode +
          // runtimeMode) to CLI's ApprovalMode and send setMode every turn.
          // AcpSessionRuntime.setMode (AcpSessionRuntime.ts:565-575) no-ops when
          // currentModeId already matches, so unconditional per-turn calls are
          // free. Errors are logged + swallowed; the server-side short-circuit
          // above is the safety net.
          const targetMode = resolveCliMode({
            interactionMode: input.interactionMode,
            runtimeMode: input.runtimeMode,
          });
          yield* ctx.acp.setMode(targetMode).pipe(
            Effect.catch((error) =>
              Effect.logWarning("[cli-acp] setMode failed", {
                threadId: input.threadId,
                requestedMode: targetMode,
                error: error.message,
              }),
            ),
          );

          // ru-fork: send the picker-selected model to qwen every turn.
          // setConfigOption is idempotent (no-ops when the value already
          // matches), so unconditional per-turn calls are free. Errors are
          // logged + swallowed, mirroring the setMode pattern above.
          if (input.modelSelection?.model) {
            yield* Effect.logDebug("[cli-acp] setModel", {
              threadId: input.threadId,
              requestedModel: input.modelSelection.model,
            });
            yield* ctx.acp.setModel(input.modelSelection.model).pipe(
              Effect.catch((error) =>
                Effect.logError("[cli-acp] setModel failed", {
                  threadId: input.threadId,
                  requestedModel: input.modelSelection?.model,
                  error: error.message,
                }),
              ),
            );
          }

          const result = yield* ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
              // ru-fork: classify CLI RPC failures through the
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
                  const decision = classify(error, Cause.fail(error));
                  if (decision !== null && decision.surface === "B") {
                    yield* Effect.logError("[runtime]", {
                      source: "cli",
                      where: "prompt",
                      threadId: input.threadId,
                      ...cliErrorFields(decision, describeRequestFailure(Cause.fail(error))),
                    });
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        // ru-fork: always prepend a blank line so the friendly
                        // B-surface text is visually separated from any assistant
                        // text already streamed into the bubble before the error.
                        text: `\n\n${decision.text}`,
                        rawPayload: error.data ?? null,
                      }),
                    );
                    return {
                      stopReason: "end_turn" as const,
                    } satisfies EffectAcpSchema.PromptResponse;
                  }
                  return yield* error;
                }),
              ),
              // ru-fork: capture the CLI exit code at the boundary —
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

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          // onExit covers typed failure AND defect AND interrupt; success was
          // already finalized in the body (finalize() is idempotent anyway).
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : finalizeFromCause(exit.cause),
          ),
        );
      });

    const interruptTurn: CliAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // ru-fork: Stop is a user CANCEL, not a failure. Flag the intent before
        // the force-kill so sendTurn's finalizer labels the in-flight turn
        // `cancelled` (no error banner) deterministically — the flag is set
        // before the kill that fails the prompt. abortSession runs inline here
        // (this is the request fiber, not a session-bound fiber) and awaits the
        // finalizer's turn.completed before session.exited.
        ctx.userCancelRequested = true;
        yield* abortSession(ctx, STOP_BUTTON_METHOD);
      });

    const respondToRequest: CliAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
      runtimeMode,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("cli-adapter.approval.respond.received", {
          threadId,
          requestId,
        });
        const ctx = yield* requireSession(threadId);
        // ru-fork: refresh ctx.currentRuntimeMode BEFORE settleAndDelete
        // resolves the deferred. The parked requestPermission callback resumes
        // synchronously on resolution and reads ctx.currentRuntimeMode to pick
        // the plan-approval optionId — see Branch 2 of the requestPermission
        // chain above.
        ctx.currentRuntimeMode = runtimeMode;
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          yield* Effect.logWarning("cli-adapter.approval.respond.unknown", {
            threadId,
            requestId,
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            // ru-fork: kept English — ProviderCommandReactor substring-matches
            // this detail to trigger the stale-pending-request fast-path.
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        // Plan-approval and tool/file approval both resolve through
        // `pendingApprovals` with the same `ProviderApprovalDecision`
        // response shape — `pending.kind === "exit_plan_mode"` is the
        // only distinguishing signal. Split the log/probe label so the
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
        // Fork the resume probe into the session scope — empirically
        // validated by `post-answer-resume-gap-approval.mjs` (~1 ms
        // first-frame gap) and `post-answer-resume-gap-cancel.mjs`
        // (~700 ms first-frame gap). Both well under the 10 s probe
        // timeout, so forking on every approval response is safe.
        yield* buildPostAnswerResumeProbe({
          ctx,
          requestId,
          kind,
          timeoutMs: POST_ANSWER_RESUME_TIMEOUT_MS,
          label: labelStem,
          onTimeout: Effect.gen(function* () {
            yield* Effect.logWarning("cli-adapter.abort.post-answer-resume-timeout", {
              threadId,
              requestId,
              kind,
              reason: "post-answer-resume-timeout",
            });
            // ru-fork: schedule (don't inline) — this runs forked into
            // ctx.scope, which abortSession closes; inline would self-interrupt.
            yield* scheduleTeardown(ctx, MAINTENANCE_METHOD);
          }),
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const respondToUserInput: CliAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("cli-adapter.user-input.respond.received", {
          threadId,
          requestId,
        });
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          yield* Effect.logWarning("cli-adapter.user-input.respond.unknown", {
            threadId,
            requestId,
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            // ru-fork: kept English — ProviderCommandReactor substring-matches
            // this detail to trigger the stale-pending-request fast-path.
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        // Settle the Deferred AND delete the map entry in one shot —
        // keeping the map in sync with reality the moment we commit a
        // response. The post-answer resume probe (below) snapshots
        // `wireActivity.lastIncomingAt` *after* this settle, so if CLI
        // doesn't produce an inbound frame within the timeout it gets
        // declared wedged and the session is force-aborted.
        yield* settleAndDelete({
          requestId,
          kind: "user-input",
          threadId,
          map: ctx.pendingUserInputs,
          deferred: pending.answers,
          value: answers,
          label: "cli-adapter.user-input.respond",
        });
        // Fork the probe into the session scope (`ctx.scope`) so it
        // outlives this respond call but dies on session teardown.
        // Using `forkChild` here would tie it to *this* respond
        // Effect, which would interrupt the probe the instant
        // `respondToUserInput` returns — defeating the whole point.
        yield* buildPostAnswerResumeProbe({
          ctx,
          requestId,
          kind: "user-input",
          timeoutMs: POST_ANSWER_RESUME_TIMEOUT_MS,
          label: "cli-adapter.user-input",
          onTimeout: Effect.gen(function* () {
            yield* Effect.logWarning("cli-adapter.abort.post-answer-resume-timeout", {
              threadId,
              requestId,
              reason: "post-answer-resume-timeout",
            });
            // ru-fork: schedule (don't inline) — this runs forked into
            // ctx.scope, which abortSession closes; inline would self-interrupt.
            yield* scheduleTeardown(ctx, MAINTENANCE_METHOD);
          }),
        }).pipe(Effect.forkIn(ctx.scope));
      });

    const readThread: CliAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CliAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns должен быть целым числом ≥ 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CliAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* abortSession(ctx, MAINTENANCE_METHOD);
        }),
      );

    const listSessions: CliAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CliAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const hasParkedRequests: CliAdapterShape["hasParkedRequests"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        if (c === undefined || c.stopped) return false;
        return c.pendingApprovals.size > 0 || c.pendingUserInputs.size > 0;
      });

    const stopAll: CliAdapterShape["stopAll"] = () =>
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
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
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
    } satisfies CliAdapterShape;
  });
}
