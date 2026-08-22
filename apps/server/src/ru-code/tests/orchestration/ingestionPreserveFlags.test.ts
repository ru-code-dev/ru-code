// ru-code: preserve-modes seam — INGESTION-SIDE flag matrix. The decider half
// of the seam is pinned in sessionSetPreserveModes.test.ts (flags in →
// resolved event out); THIS file pins the other half: for every runtime event
// type/payload arm, the REAL `ProviderRuntimeIngestion` must dispatch a
// `thread.session.set` command with exactly the right values AND preserve
// flags. The flags are only observable on the COMMAND (the emitted event is
// already resolved), so the harness wraps the real engine's dispatch with a
// recorder and drives events through the real ingestion queue.
//
// The rules under pin (ProviderRuntimeIngestion.ts, flag derivation):
//   preserveLastError  — absent when the arm intentionally SETS lastError
//                        (error-state, banner-failed-turn) or intentionally
//                        CLEARS it (status "ready"); `true` on every arm that
//                        merely carries the stale read (starting/stopped/
//                        running/waiting states, banner-suppressed failures,
//                        turn.started, mid-turn lifecycle notifications,
//                        session.exited).
//   preserveActiveTurnId — `true` for session.started / thread.started, and for
//                        session.state.changed ONLY when the resolved status
//                        still allows an active turn (starting/running, which
//                        includes "waiting" — upstream 501ce27b8 #3159); absent
//                        for the other session.state.changed arms (ready/
//                        error/stopped — an intentional CLEAR) and for
//                        turn.started / turn.completed / session.exited (they
//                        SET it).
//
// Provider-neutral by construction: the harness drives a "codex" session —
// the seam applies to every provider riding this ingestion path, not just qwen.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { McpManagerSecretStoreMemory } from "../../mcp/mcpPorts.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-flags");
const THREAD_ID = ThreadId.make("thread-flags");
const TURN_ID = TurnId.make("turn-flags-1");
const CODEX = ProviderDriverKind.make("codex");

type SessionSetCommand = Extract<OrchestrationCommand, { type: "thread.session.set" }>;

const createProviderServiceStub = Effect.gen(function* () {
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const runtimeSessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    compactContext: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    hasParkedRequests: () => Effect.succeed(false),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(runtimeEventPubSub, event);
  const setSession = (session: ProviderSession): void => {
    runtimeSessions.push(session);
  };
  return { service, emit, setSession };
});

// Build the REAL engine + ingestion stack (scoped to the test), with the
// engine's dispatch wrapped by a command recorder — the seam's observable
// output is the COMMAND (flags are resolved away in the emitted event).
const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const nodePath = yield* Path.Path;
  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ru-code-flags-" });
  yield* fileSystem.makeDirectory(nodePath.join(workspaceRoot, ".git"));

  const recorded: OrchestrationCommand[] = [];
  const provider = yield* createProviderServiceStub;

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(McpManagerSecretStoreMemory),
  );
  const recordingEngineLayer = Layer.effect(
    OrchestrationEngineService,
    Effect.gen(function* () {
      const real = yield* OrchestrationEngineService;
      const wrapped: OrchestrationEngineShape = {
        readEvents: (fromSequenceExclusive, limit) => real.readEvents(fromSequenceExclusive, limit),
        // ru-code: t3 added `latestSequence` to OrchestrationEngineShape (A15).
        latestSequence: real.latestSequence,
        dispatch: (command) =>
          Effect.suspend(() => {
            recorded.push(command);
            return real.dispatch(command);
          }),
        get streamDomainEvents() {
          return real.streamDomainEvents;
        },
      };
      return wrapped;
    }),
  ).pipe(Layer.provide(orchestrationLayer));
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(McpManagerSecretStoreMemory),
  );
  const layer = ProviderRuntimeIngestionLive.pipe(
    // ru-code: ProviderRuntimeIngestion writes both registries (t3 change); provide them here.
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(recordingEngineLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  const engine = Context.get(context, OrchestrationEngineService);
  const ingestion = Context.get(context, ProviderRuntimeIngestionService);
  yield* ingestion.start();

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-flags-project"),
    projectId: PROJECT_ID,
    title: "Flags Project",
    workspaceRoot,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: NOW,
  });
  yield* engine.dispatch({
    type: "thread.create",
    chatViewMode: null, // ru-code: thread-state chat view (extended chat)
    commandId: CommandId.make("cmd-flags-thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Flags Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
  provider.setSession({
    provider: CODEX,
    status: "ready",
    runtimeMode: "approval-required",
    threadId: THREAD_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });

  // Seed the CURRENT projected session directly (no flags — plain set).
  let seedCounter = 0;
  const seedSession = (input: {
    readonly status: "ready" | "starting" | "running" | "stopped" | "error";
    readonly lastError: string | null;
    readonly activeTurnId: TurnId | null;
  }) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-flags-seed-${++seedCounter}`),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: input.status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: input.activeTurnId,
        lastError: input.lastError,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });

  let eventCounter = 0;
  // Emit one runtime event, wait for the ingestion queue to process it, and
  // return the thread.session.set command it dispatched (if any).
  const emitAndCapture = (build: (eventId: EventId) => ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      recorded.length = 0;
      yield* provider.emit(build(EventId.make(`evt-flags-${++eventCounter}`)));
      yield* ingestion.drain;
      const commands = recorded.filter(
        (command): command is SessionSetCommand => command.type === "thread.session.set",
      );
      assert.isAtMost(commands.length, 1, "at most one session.set per runtime event");
      return commands[0];
    });

  return { seedSession, emitAndCapture };
});

it.effect(
  "session.state.changed: error/ready arms SET (no preserveLastError); every state carries preserveActiveTurnId",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedSession({
        status: "ready",
        lastError: "current banner",
        activeTurnId: null,
      });

      // error WITH a reason — intentional set: the reason wins, no preserve.
      const errorWithReason = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "error", reason: "boom" },
      }));
      assert.isDefined(errorWithReason);
      assert.strictEqual(errorWithReason!.session.status, "error");
      assert.strictEqual(errorWithReason!.session.lastError, "boom");
      assert.isUndefined(errorWithReason!.preserveLastError);
      assert.isUndefined(errorWithReason!.preserveActiveTurnId);

      // error WITHOUT a reason — still the intentional-set arm (no preserve),
      // and the command value falls back to the ingestion's own read. This pins
      // the DOCUMENTED residual stale-fallback window: the fallback is a
      // read-time value, not preserve-resolved.
      const errorNoReason = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "error" },
      }));
      assert.strictEqual(errorNoReason!.session.lastError, "boom"); // carried from the read
      assert.isUndefined(errorNoReason!.preserveLastError);
      assert.isUndefined(errorNoReason!.preserveActiveTurnId);

      // ready — intentional CLEAR: lastError null, no preserve.
      const ready = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "ready" },
      }));
      assert.strictEqual(ready!.session.status, "ready");
      assert.isNull(ready!.session.lastError);
      assert.isUndefined(ready!.preserveLastError);
      assert.isUndefined(ready!.preserveActiveTurnId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "session.state.changed: starting/stopped/waiting carry the banner — preserveLastError declared",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedSession({
        status: "error",
        lastError: "classified banner",
        activeTurnId: null,
      });

      const starting = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "starting" },
      }));
      assert.strictEqual(starting!.session.status, "starting");
      assert.strictEqual(starting!.session.lastError, "classified banner"); // carried value…
      assert.strictEqual(starting!.preserveLastError, true); // …AND declared preserve
      assert.strictEqual(starting!.preserveActiveTurnId, true);

      const waiting = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "waiting", reason: "awaiting approval" },
      }));
      assert.strictEqual(waiting!.session.status, "running");
      assert.strictEqual(waiting!.preserveLastError, true);
      assert.strictEqual(waiting!.preserveActiveTurnId, true);

      const stopped = yield* harness.emitAndCapture((eventId) => ({
        type: "session.state.changed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: { state: "stopped" },
      }));
      assert.strictEqual(stopped!.session.status, "stopped");
      assert.strictEqual(stopped!.session.lastError, "classified banner");
      assert.strictEqual(stopped!.preserveLastError, true);
      assert.isUndefined(stopped!.preserveActiveTurnId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "turn.completed: banner-failed SETS, banner-suppressed PRESERVES, success CLEARS; activeTurnId is always SET (no preserve)",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedSession({
        status: "error",
        lastError: "existing banner",
        activeTurnId: null,
      });

      const startTurn = harness.emitAndCapture((eventId) => ({
        type: "turn.started",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: {},
      }));

      // failed WITHOUT showNotification — the banner arm intentionally SETS.
      yield* startTurn;
      const failedBanner = yield* harness.emitAndCapture((eventId) => ({
        type: "turn.completed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: { state: "failed", errorMessage: "turn failed" },
      }));
      assert.strictEqual(failedBanner!.session.status, "error");
      assert.strictEqual(failedBanner!.session.lastError, "turn failed");
      assert.isNull(failedBanner!.session.activeTurnId);
      assert.isUndefined(failedBanner!.preserveLastError);
      assert.isUndefined(failedBanner!.preserveActiveTurnId);

      // failed with showNotification=false (Timeline-only) — the banner is NOT
      // touched: carried over AND declared preserve.
      yield* harness.seedSession({
        status: "error",
        lastError: "existing banner",
        activeTurnId: null,
      });
      yield* startTurn;
      const failedQuiet = yield* harness.emitAndCapture((eventId) => ({
        type: "turn.completed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: { state: "failed", errorMessage: "quiet failure", showNotification: false },
      }));
      assert.strictEqual(failedQuiet!.session.status, "error");
      assert.strictEqual(failedQuiet!.session.lastError, "existing banner");
      assert.strictEqual(failedQuiet!.preserveLastError, true);
      assert.isUndefined(failedQuiet!.preserveActiveTurnId);

      // completed — status ready intentionally CLEARS the banner.
      yield* startTurn;
      const completed = yield* harness.emitAndCapture((eventId) => ({
        type: "turn.completed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: { state: "completed" },
      }));
      assert.strictEqual(completed!.session.status, "ready");
      assert.isNull(completed!.session.lastError);
      assert.isNull(completed!.session.activeTurnId);
      assert.isUndefined(completed!.preserveLastError);
      assert.isUndefined(completed!.preserveActiveTurnId);

      // cancelled — ready-clears too, and settles the turn as interrupted.
      yield* startTurn;
      const cancelled = yield* harness.emitAndCapture((eventId) => ({
        type: "turn.completed",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: { state: "cancelled" },
      }));
      assert.strictEqual(cancelled!.session.status, "ready");
      assert.isUndefined(cancelled!.preserveLastError);
      assert.isUndefined(cancelled!.preserveActiveTurnId);
      assert.strictEqual(cancelled!.settledTurnState, "interrupted");
      assert.strictEqual(cancelled!.settledTurnId, TURN_ID);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "lifecycle arms: turn.started/session.exited SET activeTurnId; session.started/thread.started preserve it",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.seedSession({ status: "error", lastError: "banner", activeTurnId: null });

      // turn.started — SETS activeTurnId (no preserve), carries the banner.
      const turnStarted = yield* harness.emitAndCapture((eventId) => ({
        type: "turn.started",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        turnId: TURN_ID,
        payload: {},
      }));
      assert.strictEqual(turnStarted!.session.status, "running");
      assert.strictEqual(turnStarted!.session.activeTurnId, TURN_ID);
      assert.strictEqual(turnStarted!.session.lastError, "banner");
      assert.strictEqual(turnStarted!.preserveLastError, true);
      assert.isUndefined(turnStarted!.preserveActiveTurnId);

      // session.started MID-TURN — carries BOTH: running (not ready ⇒ preserve
      // banner) and the active turn (preserveActiveTurnId).
      const sessionStartedMidTurn = yield* harness.emitAndCapture((eventId) => ({
        type: "session.started",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: {},
      }));
      assert.strictEqual(sessionStartedMidTurn!.session.status, "running");
      assert.strictEqual(sessionStartedMidTurn!.session.activeTurnId, TURN_ID);
      assert.strictEqual(sessionStartedMidTurn!.preserveLastError, true);
      assert.strictEqual(sessionStartedMidTurn!.preserveActiveTurnId, true);

      // thread.started MID-TURN — same carry-over arms.
      const threadStartedMidTurn = yield* harness.emitAndCapture((eventId) => ({
        type: "thread.started",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: {},
      }));
      assert.strictEqual(threadStartedMidTurn!.session.status, "running");
      assert.strictEqual(threadStartedMidTurn!.preserveLastError, true);
      assert.strictEqual(threadStartedMidTurn!.preserveActiveTurnId, true);

      // session.exited — SETS activeTurnId null (no preserve); status stopped
      // is not "ready", so the banner is carried with preserve declared.
      const exited = yield* harness.emitAndCapture((eventId) => ({
        type: "session.exited",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: {},
      }));
      assert.strictEqual(exited!.session.status, "stopped");
      assert.isNull(exited!.session.activeTurnId);
      assert.strictEqual(exited!.preserveLastError, true);
      assert.isUndefined(exited!.preserveActiveTurnId);

      // session.started IDLE (no active turn) — status ready ⇒ intentional
      // banner CLEAR (no preserveLastError), activeTurnId still preserved.
      const sessionStartedIdle = yield* harness.emitAndCapture((eventId) => ({
        type: "session.started",
        eventId,
        provider: CODEX,
        threadId: THREAD_ID,
        createdAt: NOW,
        payload: {},
      }));
      assert.strictEqual(sessionStartedIdle!.session.status, "ready");
      assert.isNull(sessionStartedIdle!.session.lastError);
      assert.isUndefined(sessionStartedIdle!.preserveLastError);
      assert.strictEqual(sessionStartedIdle!.preserveActiveTurnId, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
