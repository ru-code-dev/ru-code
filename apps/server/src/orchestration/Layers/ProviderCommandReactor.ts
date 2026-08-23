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
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
// ru-code: respawn the live qwen session on the next turn when the thread's effective skill/agent set
// changes (qwen reads them only at spawn). All logic is in the ru-code gate service; the reactor only
// calls it. See SessionRespawnGate.
import { SessionRespawnGate } from "../../ru-code/skills-agents/SessionRespawnGate.ts";
// ru-code: per-project MCP overlay resolved (in memory) at turn-start; the file is written
// only by an actual spawn. Kill-switch + fingerprint tracking live in the package service;
// the per-turn choreography lives in the zone module — this file only makes thin calls.
import { McpSessionOverlay } from "@smart-tools/qwen-cli-mcp-manager/server";
import { makeMcpTurnOverlay, type McpOverlaySpawnKind } from "../../ru-code/mcp/mcpTurnOverlay.ts";
import { provisionThenSpawn } from "../../ru-code/skills-agents/provisionThenSpawn.ts";
import { shouldRestartProviderSession } from "../../ru-code/skills-agents/respawnDecision.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.context-compact-requested" // ru-code
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

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
// ru-code: server fallback aligned to the canonical safe default (was "full-access"). See
// WORKFLOW/decisions.md row 17 / patch-defects 05-D1.
const DEFAULT_RUNTIME_MODE: RuntimeMode = "auto-accept-edits";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

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

// ru-code: widened Cause<ProviderServiceError> → Cause<unknown> so the classified
// start-failure path can reuse this finder with its differently-typed cause. The two
// legacy callers still pass ProviderServiceError causes (assignable to unknown).
function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
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
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

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
  // ru-code: the start() scope — long-running compressions fork into it so
  // they outlive a single worker step but still die with the reactor.
  const compactForkScopeRef = yield* Ref.make(Option.none<Scope.Scope>());
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  // ru-code: skill/agent respawn gate (fingerprint tracking + change decision live in the service).
  const respawnGate = yield* SessionRespawnGate;
  // ru-code: MCP session-overlay gate (turn-start overlay write + per-thread fingerprint diff).
  const mcpSessionOverlay = yield* McpSessionOverlay;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
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
      | "provider.context.compact.failed" // ru-code
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
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
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
    // ru-code: preserve-modes seam passthrough — a caller whose lastError is
    // merely carried over from its own stale read declares it (see
    // ThreadSessionSetCommand).
    readonly preserveLastError?: boolean;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          ...(input.preserveLastError === true ? { preserveLastError: true } : {}),
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
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

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
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
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
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

    // ru-code: resolve the per-project MCP overlay ONCE at turn-start — IN MEMORY, no file
    // write. The fingerprint drives the respawn diff; the FILE is written only by an actual
    // spawn with ≥1 enabled server. Choreography lives in the zone module (mcpTurnOverlay.ts).
    const mcpOverlayTurn = yield* makeMcpTurnOverlay({
      mcpSessionOverlay,
      projectId: thread.projectId,
      threadId,
    });
    const currentOverlayFingerprint = mcpOverlayTurn.fingerprint;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
      readonly spawnKind?: McpOverlaySpawnKind; // ru-code: fresh-spawn vs respawn, for the overlay logs
    }) =>
      // ru-code: qwen reads skills/agents/commands from <cwd>/.qwen at spawn, but the catalogs only
      // write the project's main workspaceRoot — so mirror the worktree's copies in BEFORE the spawn
      // and record what it loaded AFTER. The provision→spawn→record ordering + its test live in the
      // ru-code zone (provisionThenSpawn); here we only supply the gate, the target, and the spawn
      // thunk (thunk so the session-start effect is not constructed until the mirrors are in place).
      provisionThenSpawn(
        respawnGate,
        { threadId, projectId: thread.projectId, cwd: effectiveCwd ?? null },
        () =>
          // ru-code: the MCP overlay file is written HERE — only on an actual spawn
          // (zone: mcpTurnOverlay). Empty fields ⇒ a clean no-MCP spawn.
          Effect.flatMap(
            mcpOverlayTurn.overlayFieldsForSpawn(input?.spawnKind ?? "fresh-spawn"),
            (mcpOverlayFields) =>
              providerService.startSession(threadId, {
                threadId,
                ...(preferredProvider ? { provider: preferredProvider } : {}),
                providerInstanceId: desiredInstanceId,
                ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                // t3 #5941: the real thread title goes in at session create, so OpenCode
                // stops minting a placeholder and mirroring it back over the user's title.
                ...(thread.title ? { title: thread.title } : {}),
                modelSelection: desiredModelSelection,
                ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
                runtimeMode: desiredRuntimeMode,
                // ru-code: the MCP overlay path + server allowlist for this spawn.
                ...mcpOverlayFields,
              }),
          ),
      );

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
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
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
        // ru-code: record the overlay state this (re)spawn was based on, so the next
        // turn's `overlayChanged` check compares against it.
        yield* mcpOverlayTurn.recordSpawn;
      });

    // ru-code[HEAVY]: the spawn-decision region — respawn, reuse, or fresh spawn — is wrapped
    // in one effect so an ephemeral overlay FILE (plaintext secrets), if this turn's spawn
    // wrote one, is deleted the moment the region settles (success, failure, or interrupt):
    // the file is only needed until a freshly spawned child boots and reads it; reuse turns
    // and 0-server spawns never write one. The restart DECISION uses the in-memory
    // fingerprint, never the file, so deleting it cannot trigger a spurious respawn next
    // turn. Body is unchanged upstream logic, only indented.
    const decideAndSpawn = Effect.gen(function* () {
      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
        const cwdChanged = effectiveCwd !== activeSession?.cwd;
        const capabilities = yield* providerService.getCapabilities(desiredInstanceId);
        const sessionModelSwitch = capabilities.sessionModelSwitch;
        // ru-code: a capable adapter (qwen) applies runtime-mode changes live via per-turn
        // setMode, so it must NOT respawn on a mode change. Every other adapter leaves the
        // flag unset ⇒ shouldRestartForRuntimeMode === runtimeModeChanged ⇒ respawns as before.
        const shouldRestartForRuntimeMode =
          runtimeModeChanged && capabilities.supportsInSessionRuntimeMode !== true;
        const modelChanged =
          requestedModelSelection !== undefined &&
          requestedModelSelection.model !== activeSession?.model;
        const instanceChanged =
          requestedModelSelection !== undefined &&
          activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
        const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
        const previousModelSelection = threadModelSelections.get(threadId);
        const shouldRestartForModelSelectionChange =
          preferredProvider === "claudeAgent" &&
          requestedModelSelection !== undefined &&
          !Equal.equals(previousModelSelection, requestedModelSelection);
        // ru-code: did this thread's effective skill/agent set change vs. what the live session spawned
        // with? qwen reads them only at spawn, so a change re-spawns on this turn (resume preserves
        // history). The fingerprint tracking + decision live in the ru-code gate service.
        const catalogChanged = yield* respawnGate.changedForThread(threadId, thread.projectId);
        // ru-code: the MCP overlay this thread's live session spawned with vs. the current one.
        // A changed overlay (server edited / bound / unbound / extraArgs / tool policy / trust)
        // re-spawns on this turn with resumeCursor — qwen only reads the overlay at spawn. The
        // fingerprint subsumes the allow-list (removing an MCP changes it).
        const overlayChanged = yield* mcpOverlayTurn.overlayChanged;

        // ru-code: restart iff any dimension changed — extracted as a pure predicate so the decision
        // (incl. the skill/agent `catalogChanged` dimension) is unit-tested in respawnDecision.test.ts.
        if (
          !shouldRestartProviderSession({
            // ru-code: the base gates runtime-mode restart by capability (qwen applies the mode live via
            // per-turn setMode), so feed the gated `shouldRestartForRuntimeMode` — NOT raw
            // runtimeModeChanged — into the predicate's runtimeModeChanged slot.
            runtimeModeChanged: shouldRestartForRuntimeMode,
            cwdChanged,
            instanceChanged,
            shouldRestartForModelChange,
            shouldRestartForModelSelectionChange,
            catalogChanged,
            overlayChanged,
          })
        ) {
          // ru-code: live session reused — nothing spawns, so no overlay file is written.
          yield* mcpOverlayTurn.logReuseSkip;
          return existingSessionThreadId;
        }

        const resumeCursor = shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
        // ru-code: debug — reactor restart diagnostics are not user-facing output.
        yield* Effect.logDebug("provider command reactor restarting provider session", {
          threadId,
          existingSessionThreadId,
          currentProvider: activeSession?.provider,
          currentInstanceId,
          desiredInstanceId,
          desiredProvider: desiredModelSelection.instanceId,
          currentRuntimeMode: thread.session?.runtimeMode,
          desiredRuntimeMode: thread.runtimeMode,
          runtimeModeChanged,
          previousCwd: activeSession?.cwd,
          desiredCwd: effectiveCwd,
          cwdChanged,
          modelChanged,
          instanceChanged,
          shouldRestartForModelChange,
          shouldRestartForModelSelectionChange,
          catalogChanged, // ru-code: a skill/subagent add/remove/sync forced this respawn (qwen re-reads at spawn)
          // ru-code: the MCP overlay trigger — a changed overlay fingerprint re-spawns the session
          // so qwen re-reads the overlay. Logged so an MCP-config-driven restart is visible.
          overlayChanged,
          currentOverlayFingerprint,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const restartedSession = yield* startProviderSession({
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          spawnKind: "respawn", // ru-code: refined into a per-cause overlay spawnReason
        });
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

    // ru-code: delete the ephemeral overlay file once the spawn-decision region settles
    // (see the HEAVY note above) — IF this turn wrote one; reuse turns and 0-server
    // spawns write nothing.
    return yield* mcpOverlayTurn.withCleanup(decideAndSpawn);
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
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });
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
      // ru-code: forward the thread's live runtime mode so a capable adapter (qwen)
      // applies it via setMode this turn without a respawn; other adapters ignore it.
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
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

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
        commandId: yield* serverCommandId("worktree-branch-rename"),
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
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
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

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
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

    // ru-code: send-while-parked guard. If the active session is holding a
    // permission/plan/user-input Deferred (e.g. a plan approval still parked
    // from a previous turn the user navigated away from), starting a new turn
    // now would deadlock against qwen's in-flight prompt() RPC. Interrupt first
    // so the held Deferred settles, the previous turn ends, and the new turn
    // starts on a clean session.
    const isParked = yield* providerService
      .hasParkedRequests(event.payload.threadId)
      .pipe(Effect.orElseSucceed(() => false));
    if (isParked) {
      yield* Effect.logDebug(
        "provider command reactor auto-interrupting parked session before turn start",
        { threadId: event.payload.threadId, messageId: event.payload.messageId },
      );
      yield* providerService
        .interruptTurn({ threadId: event.payload.threadId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              "provider command reactor auto-interrupt before turn-start failed; proceeding anyway",
              { threadId: event.payload.threadId, cause: Cause.pretty(cause) },
            ),
          ),
        );
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

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      // ru-code: when the start-failure is a classified provider error (e.g. a qwen
      // session-start/B3 spawn failure remapped to `ProviderAdapterRequestError` by
      // the adapter), use its classified detail as the timeline row summary too —
      // not the generic "Provider turn start failed". Falls back to the generic
      // summary for the `Cause.pretty` case (no provider detail), so non-qwen /
      // unclassified failures are unaffected.
      const classifiedSummary =
        findProviderAdapterRequestError(cause)?.detail ?? "Provider turn start failed";
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: classifiedSummary,
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

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
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause(recoverTurnStartFailure), Effect.forkScoped);
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

  // ru-code: hidden context compaction — run `/compress` on the live provider
  // session with no user message. The adapter is the single writer of the
  // success surfaces (timeline "Context compacted" row + token-usage update); this
  // reactor owns the failure surface (a timeline failure row), mirroring the
  // interrupt handler above.
  const processContextCompactRequested = Effect.fn("processContextCompactRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.context-compact-requested" }>,
  ) {
    const threadExists = yield* resolveThread(event.payload.threadId);
    if (!threadExists) {
      return;
    }
    // ru-code: no live-session pre-check here (unlike the interrupt handler
    // above — interrupting nothing is meaningless, compacting a RESUMABLE
    // thread is not). A confirmed compression retires the session on purpose
    // (stale-chat fix; see QwenAdapter.compactContext), so compact must work
    // on a stopped-but-resumable thread: ProviderService.compactContext routes
    // with allowRecovery and resumes via session/load exactly like a turn
    // would. A thread with genuinely nothing to recover (no persisted cursor)
    // fails there with a typed error, which the catchCause below turns into
    // the same timeline failure row this guard used to emit.

    // ru-code: a compression can run for minutes — awaiting it here would
    // stall the reactor's single sequential worker: every later intent parks
    // behind it (the send that must hit the adapter's "Compacting…"
    // fail-fast, other threads' approvals and turn starts). The adapter owns
    // re-entrancy, the fail-fast guard and the row closure (incl. interrupt
    // via onExit), so the reactor only LAUNCHES the compression; the fiber
    // lives in the start() scope, so reactor teardown still interrupts it
    // (→ the closing "Compaction interrupted." row).
    const runCompaction = providerService.compactContext({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.context.compact.failed",
            summary: "Could not compact the context",
            detail: formatFailureDetail(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          });
        }),
      ),
    );
    const compactForkScope = yield* Ref.get(compactForkScopeRef);
    if (Option.isSome(compactForkScope)) {
      yield* runCompaction.pipe(Effect.forkIn(compactForkScope.value));
      return;
    }
    // No start() scope (handlers driven directly in unit tests) — run inline.
    yield* runCompaction;
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        // ru-code: a stale-detail string (matched by all three clearing
        // predicates) so a request tail-orphaned by a race with Stop can
        // still be cleared client- and server-side, instead of a plain
        // English sentence no predicate recognises.
        detail: stalePendingRequestDetail("approval", event.payload.requestId),
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
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
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          // ru-code: same stale-detail swap as the approval-response site
          // above — see that comment.
          detail: stalePendingRequestDetail("user-input", event.payload.requestId),
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
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
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      // ru-code: preserve-modes seam — `lastError` above is merely CARRIED
      // OVER from this handler's projection-snapshot read; declaring preserve
      // makes the decider re-resolve it against the CURRENT session, so a
      // stop racing a concurrent banner write (the user stopping BECAUSE an
      // error just appeared) can never erase that banner. `activeTurnId` is
      // an intentional clear — no flag.
      preserveLastError: true,
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
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
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
      // ru-code: hidden context compaction.
      case "thread.context-compact-requested":
        yield* processContextCompactRequested(event);
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
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    // ru-code: remember the start scope for the forked compaction handler.
    yield* Effect.scope.pipe(
      Effect.flatMap((scope) => Ref.set(compactForkScopeRef, Option.some(scope))),
    );
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.context-compact-requested" || // ru-code
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
