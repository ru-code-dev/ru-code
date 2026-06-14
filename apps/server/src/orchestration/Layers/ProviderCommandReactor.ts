import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
// ru-fork: classifier-based error routing. See
// `ru-fork-instrumental/changes/server-errors-handaling.md`.
import { classify, UNRECOGNIZED_DECISION } from "../../ru-fork/cli-errors-handling/recognizers.ts";
import { dispatchCause } from "../../ru-fork/cli-errors-handling/dispatch.ts";
// ru-fork: per-project MCP overlay resolved at spawn (gated by the kill-switch).
import { MCP_ENGINE_USE_OVERLAY } from "../../config.ts";
import { McpOverlay } from "../../ru-fork/mcp/McpOverlay.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const SESSION_OVERLAY_FINGERPRINT_MAX = 10_000;
const SESSION_OVERLAY_FINGERPRINT_TTL = Duration.minutes(30);
const DEFAULT_THREAD_TITLE = "Новый диалог";

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

/**
 * Ru-fork: after flipping `allowRecovery: false` on the response
 * paths in ProviderService, a stale response no longer reaches the
 * adapter — it short-circuits at `requireSession` with a
 * `ProviderAdapterSessionNotFoundError`. So all "is this a stale
 * pending request?" checks must accept BOTH error shapes:
 *
 *   - `ProviderAdapterSessionNotFoundError` — adapter ctx is gone
 *     (server restart, mode-change teardown, adapter crash). The
 *     pending Deferred is also gone.
 *   - `ProviderAdapterRequestError` with detail "unknown pending …" —
 *     adapter ctx exists but the specific requestId is no longer in
 *     its in-memory map (e.g. already resolved, or never registered).
 *
 * Either way the request is unrecoverable and we surface the same
 * stale-detail to the user. See
 * `instrumental/changes/pending-requests-handling.md`.
 */
function isAdapterSessionNotFoundError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return failReason?.error?._tag === "ProviderAdapterSessionNotFoundError";
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  if (isAdapterSessionNotFoundError(cause)) {
    return true;
  }
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  if (isAdapterSessionNotFoundError(cause)) {
    return true;
  }
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

// ru-fork: friendly Russian fallback substituted into `session.lastError`
// when the upstream `detail` arrived empty. The thread.session.set schema
// requires `lastError` length >= 1, so an empty string would crash
// persistence and leave the turn live (the "Работаю" timer ticking forever).
// See `ru-fork-instrumental/changes/server-errors-handaling.md` —
// side-bug 2 in the Planned section. Empty detail also fires a tripwire
// log line so the upstream regression (a tagged error class missing a
// `message` getter) is visible in the server log.
const FALLBACK_LAST_ERROR = "Произошла ошибка. Подробности в журнале сервера.";

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const mcpOverlay = yield* McpOverlay;
  // ru-fork: per-thread MCP overlay fingerprint the live session spawned with. At turn-start we
  // re-write the overlay and, if its fingerprint differs from what this thread's session spawned
  // with, re-spawn (overlayChanged → restart on next turn, history preserved via resume). Bounded
  // (capacity + TTL) so it can't grow unbounded; an evicted entry ⇒ a safe respawn on the next turn.
  const sessionOverlayFingerprints = yield* Cache.make<string, string>({
    capacity: SESSION_OVERLAY_FINGERPRINT_MAX,
    timeToLive: SESSION_OVERLAY_FINGERPRINT_TTL,
    lookup: () => Effect.succeed(""), // unused — access is via getOption + set (mirrors handledTurnStartKeys)
  });
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  // ru-fork: `formatFailureDetail` deleted. Routing moved to the
  // classifier in `apps/server/src/ru-fork/cli-errors-handling/`.
  // The old fast path ("ProviderAdapterRequestError with non-empty
  // detail → return its detail") is now `Z_CLEAN_REQUEST_ERROR` in
  // recognizers.ts. The old `Cause.pretty` fallback is replaced by
  // `UNRECOGNIZED_DECISION` — a fixed Russian fallback in UI plus the
  // full pretty cause in the `[runtime]` breadcrumb (code: "unrecognized").

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  /**
   * Ru-fork: clear orphan turn + session state after the failed
   * response to a stale pending request. After a server restart the
   * activity log still shows `user-input.requested` (or `approval`/
   * `plan-approval`) open and the projection still shows the session
   * with `activeTurnId` set — but the in-memory adapter ctx is gone.
   * Emitting `.respond.failed` only clears the *request* flag; the
   * orphaned turn keeps the "Работаю" timer + Stop button visible.
   * This helper flips the session to `stopped` and nulls
   * `activeTurnId`, matching what `processSessionStopRequested` does
   * for an explicit stop command. See
   * `instrumental/changes/pending-requests-handling.md`.
   */
  const recoverOrphanedTurnState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session) {
      return;
    }
    if (session.status === "stopped" && session.activeTurnId === null) {
      return;
    }
    yield* Effect.logInfo("provider-command-reactor.orphan-turn.recover", {
      threadId: input.threadId,
      previousStatus: session.status,
      previousActiveTurnId: session.activeTurnId,
    });
    // Dispatch the same command the explicit Stop button uses — it
    // bundles `providerService.stopSession()` + `setThreadSession({
    // status: "stopped", activeTurnId: null })` so recovery semantics
    // match manual stop exactly. `providerService.stopSession` skips
    // the adapter call when no in-memory ctx exists (see
    // `ProviderService.ts:807`), so this is cheap when the ctx is
    // gone; if a half-recovered ctx exists it gets torn down cleanly.
    //
    // Note: response paths now use `allowRecovery: false`, so a stale
    // click no longer triggers a fresh adapter spawn — there is no
    // longer a `session.started` race to worry about. We still route
    // through `thread.session.stop` rather than a bare
    // `setThreadSession` because it's the established primitive for
    // "fully clear session state" and stays correct if recovery
    // semantics ever change.
    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: serverCommandId("provider-orphan-turn-stop"),
      threadId: input.threadId,
      createdAt: input.createdAt,
    });
  });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }

    // ru-fork: tripwire + graceful fallback. An empty `detail` means
    // something upstream produced `ProviderAdapterRequestError({ detail: "" })`
    // — typically a tagged error class with a missing or broken `message`
    // getter (see server-errors-handaling.md side-bug 1). The substitution
    // below keeps the UI graceful; the logError makes the regression visible
    // so the upstream cause can be fixed.
    if (input.detail.trim().length === 0) {
      yield* Effect.logError("[turn-start.empty-detail]", {
        threadId: input.threadId,
        hint:
          "ProviderAdapterRequestError reached us with empty .detail. " +
          "Upstream tagged error likely missing a `message` getter.",
      });
    }
    const safeDetail = input.detail.trim().length > 0 ? input.detail : FALLBACK_LAST_ERROR;

    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: safeDetail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    // ru-fork: write the per-project MCP overlay ONCE at turn-start (idempotent), so qwen sees the
    // current servers + tool policy AND we can compare its fingerprint against what this thread's
    // live session spawned with. Best-effort — an overlay failure must not block the turn.
    const mcpOverlayResult = MCP_ENGINE_USE_OVERLAY
      ? yield* mcpOverlay.writeOverlay(thread.projectId).pipe(
          Effect.catch((cause) =>
            Effect.logError("[mcp] overlay write failed — spawning without MCP overlay", {
              threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        )
      : null;
    const currentOverlayFingerprint = mcpOverlayResult?.fingerprint;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
        ...(mcpOverlayResult
          ? {
              settingsOverlayPath: mcpOverlayResult.overlayPath,
              allowedMcpServers: mcpOverlayResult.allowedServerNames,
            }
          : {}),
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
        // ru-fork: record the overlay fingerprint this (re)spawn was based on, so the next turn's
        // `overlayChanged` check compares against it.
        if (currentOverlayFingerprint !== undefined) {
          yield* Cache.set(sessionOverlayFingerprints, threadId, currentOverlayFingerprint);
        }
      });

    // ru-fork #4: the spawn-decision region — respawn, reuse, or fresh spawn. The overlay
    // file (plaintext secrets) is only needed until a freshly-spawned child boots and reads
    // it; on a reuse turn nothing reads it at all. So the moment this region settles —
    // success, a (now timeout-bounded) start failure, or interrupt — delete the file. The
    // restart DECISION uses the in-memory fingerprint, never the file, so deleting it can't
    // trigger a spurious respawn next turn (test G1).
    const decideAndSpawn = Effect.gen(function* () {
      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        // ru-fork: runtimeModeChanged removed from restart triggers — the
        // adapter receives live runtimeMode on every sendTurn / respondToRequest
        // input (see ProviderSendTurnInput / ProviderRespondToRequestInput),
        // so dropdown changes no longer require a session restart. Restart still
        // fires for cwd / provider-instance / model changes.
        const cwdChanged = effectiveCwd !== activeSession?.cwd;
        const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
          .sessionModelSwitch;
        const modelChanged =
          requestedModelSelection !== undefined &&
          requestedModelSelection.model !== activeSession?.model;
        const instanceChanged =
          requestedModelSelection !== undefined &&
          activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
        const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
        // ru-fork: the MCP overlay this thread's live session spawned with vs. the current one. A
        // changed overlay (server edited / bound / unbound / extraArgs / tool policy) re-spawns on the
        // next turn with resumeCursor — qwen only reads the overlay at spawn. The fingerprint subsumes
        // the allow-list (removing an MCP changes it). Items 8 & 9 dissolve: a stale first spawn
        // self-heals on the next turn.
        const spawnFingerprint = Option.getOrUndefined(
          yield* Cache.getOption(sessionOverlayFingerprints, threadId),
        );
        const overlayChanged =
          currentOverlayFingerprint !== undefined && spawnFingerprint !== currentOverlayFingerprint;

        if (!cwdChanged && !instanceChanged && !shouldRestartForModelChange && !overlayChanged) {
          return existingSessionThreadId;
        }

        const resumeCursor = shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
        yield* Effect.logInfo("provider command reactor restarting provider session", {
          threadId,
          existingSessionThreadId,
          currentProvider: activeSession?.provider,
          currentInstanceId,
          desiredInstanceId,
          desiredProvider: desiredModelSelection.instanceId,
          currentRuntimeMode: activeSession?.runtimeMode,
          desiredRuntimeMode: thread.runtimeMode,
          previousCwd: activeSession?.cwd,
          desiredCwd: effectiveCwd,
          cwdChanged,
          modelChanged,
          instanceChanged,
          shouldRestartForModelChange,
          // ru-fork: the MCP overlay trigger — a changed overlay fingerprint re-spawns the session so qwen
          // re-reads the overlay. Logged here so a restart caused by an MCP config change is visible.
          overlayChanged,
          spawnOverlayFingerprint: spawnFingerprint,
          currentOverlayFingerprint,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const restartedSession = yield* startProviderSession(
          resumeCursor !== undefined ? { resumeCursor } : undefined,
        );
        yield* Effect.logInfo("provider command reactor restarted provider session", {
          threadId,
          previousSessionId: existingSessionThreadId,
          restartedSessionThreadId: restartedSession.threadId,
          provider: restartedSession.provider,
          runtimeMode: restartedSession.runtimeMode,
          cwd: restartedSession.cwd,
        });
        yield* bindSessionToThread(restartedSession);
        return restartedSession.threadId;
      }

      const startedSession = yield* startProviderSession(undefined);
      yield* bindSessionToThread(startedSession);
      return startedSession.threadId;
    });

    return yield* (mcpOverlayResult === null
      ? decideAndSpawn
      : decideAndSpawn.pipe(
          Effect.ensuring(mcpOverlay.deleteOverlayFile(mcpOverlayResult.overlayPath)),
        ));
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(
      input.threadId,
      input.createdAt,
      input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {},
    );
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      // ru-fork: live runtimeMode per turn — replaces the previous
      // restart-on-runtimeMode-change path. CliAdapter reads input.runtimeMode
      // to compute setMode and updates ctx.currentRuntimeMode for closure reads.
      runtimeMode: thread.runtimeMode,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      const messageFallbackTitle = (() => {
        const firstLine = input.messageText.trim().split(/\r?\n/)[0]?.trim() ?? "";
        const compact = firstLine.replace(/\s+/g, " ");
        if (compact.length === 0) return "Новый диалог";
        return compact.length > 60 ? `${compact.slice(0, 57).trimEnd()}…` : compact;
      })();
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("thread title generation failed; using message-derived fallback", {
                threadId: input.threadId,
                cause: Cause.pretty(Cause.fail(cause)),
              }).pipe(Effect.as({ title: messageFallbackTitle })),
            ),
          );
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    // ru-fork: route turn-start failures through the cli-errors-handling
    // classifier. The classifier walks the cause chain, returns a
    // `CliErrorDecision`, and the dispatcher applies it (timeline
    // activity / red notification / kill CLI / end turn).
    // Unrecognized failures get `UNRECOGNIZED_DECISION` (generic friendly
    // Russian text in the UI, full `Cause.pretty` in the server log).
    // The old `formatFailureDetail` helper has been deleted — its fast
    // path now lives as the `Z_CLEAN_REQUEST_ERROR` recognizer.
    // ru-fork: PRE-TURN failures only (buildSendTurnRequestForThread fails
    // before sendTurn ever runs — most commonly B3 spawn, or an RPC error
    // during the initialize/session.new handshake). No `turn.started` was
    // emitted ⇒ no `turn.completed{failed}` will come ⇒ ingestion can't help ⇒
    // the reactor is the SOLE writer here, and there is no competing
    // `session.exited` (nothing live to exit). This is the only place the
    // reactor writes turn-failure projection state. A TURN failure (sendTurn
    // itself) goes through `handleTurnFailure` below (killAcp only) — its
    // presentation is written by ingestion off the finalizer's turn.completed.
    const handlePreTurnFailure = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return;

        const failReason = cause.reasons.find(Cause.isFailReason);
        const error = failReason?.error;
        const decision = classify(error, cause) ?? UNRECOGNIZED_DECISION;

        yield* dispatchCause(decision, cause, {
          killAcp: providerService
            .interruptTurn({ threadId: event.payload.threadId })
            // Best-effort: if there's no live session to kill (already
            // dead, or never attached), don't fail the dispatch. The
            // [runtime] breadcrumb above already records the failure context.
            .pipe(Effect.catch(() => Effect.void)),
          appendActivity: (detail: string) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              // ru-fork: bind to the PRIOR (settled) turn so the work-log
              // filter (session-logic.ts:492 — activity.turnId === latestTurnId)
              // keeps the row even when the thread already has turns. Falls back
              // to null when there is no prior turn (then latestTurnId is
              // undefined ⇒ the filter's `: true` branch shows it anyway).
              // `latestTurn` is the settled prior turn, NOT the racy active turn.
              turnId: thread.latestTurn?.turnId ?? null,
              createdAt: event.payload.createdAt,
            }),
          setLastError: (detail: string) =>
            setThreadSessionErrorOnTurnStartFailure({
              threadId: event.payload.threadId,
              detail,
              createdAt: event.payload.createdAt,
            }),
          endTurn: recoverOrphanedTurnState({
            threadId: event.payload.threadId,
            createdAt: event.payload.createdAt,
          }),
        });
      });

    // ru-fork: TURN failures (sendTurn itself failed). The adapter's finalizer
    // already emitted the one `turn.completed{failed}` carrying the classified
    // text + surface + real turnId, and ingestion (single writer) has written
    // the timeline row / banner / message-finalize from it. The reactor must
    // NOT write any projection state here (doing so is the two-writer race this
    // whole change removes) — its only job is to kill the session when the
    // recognizer says so. `killAcp → stopSession` (not interruptTurn) so we
    // don't set the adapter's cancel-intent flag on a genuine failure.
    const handleTurnFailure = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        // Stop / teardown interrupts → ingestion already finalized as cancelled.
        if (Cause.hasInterruptsOnly(cause)) return;
        const error = cause.reasons.find(Cause.isFailReason)?.error;
        const decision = classify(error, cause) ?? UNRECOGNIZED_DECISION;
        if (decision.killAcp === true) {
          yield* providerService
            .stopSession({ threadId: event.payload.threadId })
            .pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(
        Effect.catchCause((handlerCause) =>
          Effect.logWarning("provider command reactor failed to handle turn failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(handlerCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    // Send-while-parked guard. If the active session is currently
    // holding a permission/approval/user-input Deferred (e.g. plan-
    // approval still parked from a previous turn the user navigated
    // away from), starting a new turn now would deadlock against
    // CLI's in-flight prompt() RPC. Interrupt first so the held
    // Deferred settles, the previous turn ends, and the new turn
    // starts on a clean session. See specs/done/stop-acp-session.md
    // "Send-while-parked".
    const isParked = yield* providerService
      .hasParkedRequests(event.payload.threadId)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (isParked) {
      yield* Effect.logInfo(
        "provider command reactor auto-interrupting parked session before turn start",
        {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        },
      );
      yield* providerService
        .interruptTurn({ threadId: event.payload.threadId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "provider command reactor auto-interrupt before turn-start failed; proceeding anyway",
              { threadId: event.payload.threadId, cause: Cause.pretty(cause) },
            ),
          ),
        );
    }

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handlePreTurnFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause(handleTurnFailure), Effect.forkScoped);
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    // Bind the failure activity (if it fires) to the turn that owns
    // the pending request. Otherwise the work-log timeline filter
    // (`session-logic.ts:490` requires `activity.turnId === latestTurnId`)
    // drops the row and the user sees nothing — or a flicker if
    // `latestTurnId` happens to be null at render time. Mirrors the
    // user-input branch (`processUserInputResponseRequested`).
    const failureTurnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      yield* Effect.logWarning("provider-command-reactor.approval.no-session", {
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
      });
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: failureTurnId,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
      // Stale-restart recovery: clear any orphan activeTurnId so the
      // "Работаю" timer + Stop button don't get stuck on. See the
      // helper for why dispatching `thread.session.stop` is the right
      // shape here.
      yield* recoverOrphanedTurnState({
        threadId: event.payload.threadId,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // ru-fork: read thread.runtimeMode at dispatch time so the adapter
    // picks plan-approval optionId (and refreshes its currentRuntimeMode
    // mirror) using the value the user has on screen right now, not whatever
    // was captured at session start.
    const respondingThread = yield* resolveThread(event.payload.threadId);
    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
        runtimeMode: respondingThread?.runtimeMode ?? "approval-required",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const isStaleRequest = isUnknownPendingApprovalRequestError(cause);
            // ru-fork: bump live-failure log to error level — stale
            // requests are expected (post-restart orphans) and stay at
            // warn. Live failures mean CLI is parked waiting and we
            // couldn't deliver the response, which is operational.
            yield* (isStaleRequest ? Effect.logWarning : Effect.logError)(
              "provider-command-reactor.approval.cause",
              {
                threadId: event.payload.threadId,
                requestId: event.payload.requestId,
                stale: isStaleRequest,
                cause: Cause.pretty(cause),
              },
            );
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              // ru-fork: friendly Russian instead of Cause.pretty
              // for the live-failure branch. F2 in the routing table —
              // CLI alive and parked, user retries submission. The full
              // `Cause.pretty` is in the server log via the line above.
              detail: isStaleRequest
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : "Не удалось отправить ответ-разрешение в Cli. Попробуйте отправить ответ снова.",
              turnId: failureTurnId,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });
            // Stale-request branch is exactly the after-restart case:
            // DB still shows the session running and a turn active, but
            // the adapter ctx is gone. Clear the orphan state. Mirrors
            // `processUserInputResponseRequested`.
            if (isStaleRequest) {
              yield* recoverOrphanedTurnState({
                threadId: event.payload.threadId,
                createdAt: event.payload.createdAt,
              });
            }
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      // Bind the failure activity (if it fires) to the turn that owns
      // the pending request. Otherwise the work-log timeline filter
      // (`session-logic.ts:490` requires `activity.turnId === latestTurnId`)
      // drops the row and the user sees nothing — or a flicker if
      // `latestTurnId` happens to be null at render time. Prefer the
      // active turn; fall back to the latest turn so a freshly-completed
      // turn still carries the failure forward to the work log.
      const failureTurnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        yield* Effect.logWarning("provider-command-reactor.user-input.no-session", {
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: failureTurnId,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
        // Stale-restart recovery: clear any orphan activeTurnId so the
        // "Работаю" timer + Stop button don't get stuck on. See helper
        // comment for context.
        yield* recoverOrphanedTurnState({
          threadId: event.payload.threadId,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const isStaleRequest = isUnknownPendingUserInputRequestError(cause);
              // ru-fork: bump live-failure log to error level — see
              // approval-response branch above for rationale.
              yield* (isStaleRequest ? Effect.logWarning : Effect.logError)(
                "provider-command-reactor.user-input.cause",
                {
                  threadId: event.payload.threadId,
                  requestId: event.payload.requestId,
                  stale: isStaleRequest,
                  cause: Cause.pretty(cause),
                },
              );
              yield* appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.user-input.respond.failed",
                summary: "Provider user input response failed",
                // ru-fork: friendly Russian instead of Cause.pretty
                // for the live-failure branch. F5 in the routing table —
                // CLI alive and parked, user retries submission.
                detail: isStaleRequest
                  ? stalePendingRequestDetail("user-input", event.payload.requestId)
                  : "Не удалось отправить ответ на запрос Cli. Попробуйте отправить ответ снова.",
                turnId: failureTurnId,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              });
              // Stale-request branch is exactly the after-restart case:
              // DB still shows the session running and a turn active, but
              // the adapter ctx is gone. Clear the orphan state.
              if (isStaleRequest) {
                yield* recoverOrphanedTurnState({
                  threadId: event.payload.threadId,
                  createdAt: event.payload.createdAt,
                });
              }
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
