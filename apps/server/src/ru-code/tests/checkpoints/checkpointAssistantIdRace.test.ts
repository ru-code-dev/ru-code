// @effect-diagnostics nodeBuiltinImport:off
// ru-code: sometimes-no-diff-in-chat — the checkpoint↔assistant-message
// attachment contracts. The chat timeline attaches a turn's diff chip (and
// derives the revert count) by looking up `checkpoints[].assistantMessageId`
// among rendered message rows. CheckpointReactor's turn-completion capture
// resolves that id from the PROJECTED thread at capture time and falls back to
// a synthetic `assistant:<turnId>` id when the assistant message is not
// projected yet (the reactor and the message ingestion race on the same
// runtime-event stream).
//
// Two orderings, verified here:
//   1. capture first, message after — the projection HEALS (message-sent
//      back-fills the turn's assistantMessageId). The first two cases pin that
//      healing as regression coverage; they PASS.
//   2. message first, checkpoint event after — the synthetic id in the
//      thread.turn.diff.complete payload CLOBBERS the already-correct
//      projection value (ProjectionPipeline turn-diff-complete upsert), and
//      nothing heals it afterwards: diff visible in the Diff panel, absent in
//      chat, revert gone, reload does not help. The last case is the INTENDED
//      contract for that ordering and FAILS on current code.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach } from "vite-plus/test";

import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../../checkpointing/Utils.ts";
import { ServerConfig } from "../../../config.ts";
import { CheckpointReactorLive } from "../../../orchestration/Layers/CheckpointReactor.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "../../../orchestration/Layers/RuntimeReceiptBus.ts";
// ru-code: fixture rot — ProjectionSnapshotQuery now requires these services
// (F4a, decisions row 22/26 fix round; ThreadPlanProgress found masked behind
// ThreadBackgroundLiveness on the Round-2 re-run).
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { CheckpointReactor } from "../../../orchestration/Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
// ru-code: memory MCP secret store for the engine decider context.
import { McpManagerSecretStoreMemory } from "../../mcp/mcpPorts.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../provider/Services/ProviderService.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

const THREAD = ThreadId.make("thread-1");
const TURN = TurnId.make("7e10f236-d7a8-4076-9782-6dcb33be3a00");
// ru-code: the REAL qwen message-id shape (ingestion mints `assistant:` +
// provider itemId, and qwen item ids are `assistant:<sessionId>:r<nonce>:segment:N`
// — so real ids start with `assistant:assistant:`). The old prefix-based
// synthetic classifier treated exactly these as synthetic; simplified
// `assistant-real-1`-style fixtures are why that shipped.
const REAL_ASSISTANT_MESSAGE = MessageId.make(
  "assistant:assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:0",
);
const MARKER_ASSISTANT_MESSAGE = MessageId.make(
  "assistant:assistant:9169ba0d-07ac-473e-9195-25728b8743ee:rfbf8c311:segment:1",
);
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const PROVIDER = ProviderDriverKind.make("codex");

function runGit(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createGitRepository(): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-checkpoint-race-"));
  tempDirs.push(cwd);
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0;
}

const providerService = (
  cwd: string,
  runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>,
): ProviderServiceShape => {
  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  return {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    compactContext: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () =>
      Effect.succeed([
        {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: "full-access",
          threadId: THREAD,
          cwd,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ] satisfies ReadonlyArray<ProviderSession>),
    hasParkedRequests: () => Effect.succeed(false),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: PROVIDER,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: PROVIDER,
          continuationKey: `codex:instance:${instanceId}`,
        },
      }),
    rollbackConversation: () => Effect.void,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };
};

const harnessLayer = (cwd: string, runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    // ru-code: the engine decider now carries the MCP secret-store port (not exercised here).
    Layer.provide(McpManagerSecretStoreMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
    getStatus: () => Effect.die("getStatus should not be called in this test"),
    refreshLocalStatus: () =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
    streamStatus: () => Stream.empty,
  });

  return CheckpointReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusLive),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService(cwd, runtimeEventPubSub))),
    Layer.provideMerge(vcsStatusBroadcasterLayer),
    Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
    Layer.provideMerge(
      WorkspaceEntries.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provideMerge(VcsDriverRegistry.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-cp-race-" })),
    Layer.provideMerge(NodeServices.layer),
    // ru-code: fixture rot — ThreadBackgroundLiveness (F4a).
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    // ru-code: fixture rot — ThreadPlanProgress (F4a, found masked behind
    // ThreadBackgroundLiveness).
    Layer.provideMerge(ThreadPlanProgress.layer),
  );
};

interface ReadThread {
  readonly id: ThreadId;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly turnId?: string | null;
  }>;
  readonly checkpoints: ReadonlyArray<{
    readonly turnId: string | null;
    readonly assistantMessageId: string | null;
    readonly status: string;
  }>;
}

/** All members die on failure — the tests only assert on projected state. */
interface HarnessApi {
  readonly dispatchLateSyntheticDiffComplete: Effect.Effect<void>;
  readonly waitFor: (
    predicate: (thread: ReadThread) => boolean,
    what: string,
  ) => Effect.Effect<ReadThread>;
  readonly dispatchAssistantMessage: Effect.Effect<void>;
  readonly dispatchTrailingTurnlessComplete: Effect.Effect<void>;
  readonly dispatchMarkerAssistantMessage: Effect.Effect<void>;
  readonly emitTurnStartedAndEdit: Effect.Effect<void>;
  readonly emitTurnCompleted: Effect.Effect<void>;
}

const makeHarness = (cwd: string, runtimeEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const reactor = yield* CheckpointReactor;
    yield* reactor.start();

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: ProjectId.make("project-1"),
      title: "Test Project",
      workspaceRoot: cwd,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: cwd,
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set"),
      threadId: THREAD,
      session: {
        threadId: THREAD,
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: CREATED_AT,
      },
      createdAt: CREATED_AT,
    });

    const readThread = Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getSnapshot();
      return (snapshot as { threads: ReadonlyArray<ReadThread> }).threads.find(
        (entry) => entry.id === THREAD,
      );
    }).pipe(Effect.orDie);

    const waitFor = (predicate: (thread: ReadThread) => boolean, what: string) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 1_500; attempt += 1) {
          const thread = yield* readThread;
          if (thread && predicate(thread)) return thread;
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
      });

    const dispatchAssistantMessage = Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-delta"),
        threadId: THREAD,
        messageId: REAL_ASSISTANT_MESSAGE,
        delta: "Готово: файл создан.",
        turnId: TURN,
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete"),
        threadId: THREAD,
        messageId: REAL_ASSISTANT_MESSAGE,
        turnId: TURN,
        createdAt: CREATED_AT,
      });
      yield* waitFor(
        (thread) => thread.messages.some((message) => message.id === REAL_ASSISTANT_MESSAGE),
        "assistant message in projection",
      );
    }).pipe(Effect.orDie, Effect.asVoid);

    // ru-code: the trailing completion shape from the live 12:52 log — the
    // SAME messageId completed a second time with NO turn binding (the ACP
    // runtime's post-prompt segment close consumed after the finalizer). The
    // projections must treat "no turnId" as no information.
    const dispatchTrailingTurnlessComplete = engine
      .dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-trailing"),
        threadId: THREAD,
        messageId: REAL_ASSISTANT_MESSAGE,
        createdAt: CREATED_AT,
      })
      .pipe(Effect.orDie, Effect.asVoid);

    // ru-code: ordering marker — a later message whose projection PROVES the
    // pipeline has advanced past the trailing completion (asserting "nothing
    // changed" needs a fence, not a sleep).
    const dispatchMarkerAssistantMessage = Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-marker"),
        threadId: THREAD,
        messageId: MARKER_ASSISTANT_MESSAGE,
        turnId: TURN,
        createdAt: CREATED_AT,
      });
      yield* waitFor(
        (thread) => thread.messages.some((message) => message.id === MARKER_ASSISTANT_MESSAGE),
        "marker assistant message in projection",
      );
    }).pipe(Effect.orDie, Effect.asVoid);

    const emitTurnStartedAndEdit = Effect.gen(function* () {
      yield* PubSub.publish(runtimeEventPubSub, {
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-1"),
        provider: PROVIDER,
        createdAt: CREATED_AT,
        threadId: THREAD,
        turnId: TURN,
      } as unknown as ProviderRuntimeEvent);
      for (let attempt = 0; attempt < 1_500; attempt += 1) {
        if (gitRefExists(cwd, checkpointRefForThreadTurn(THREAD, 0))) break;
        yield* Effect.sleep("10 millis");
      }
      if (!gitRefExists(cwd, checkpointRefForThreadTurn(THREAD, 0))) {
        return yield* Effect.die(new Error("Timed out waiting for the pre-turn baseline ref."));
      }
      NodeFS.writeFileSync(NodePath.join(cwd, "hello-123.md"), "hi\n", "utf8");
    }).pipe(Effect.asVoid);

    const emitTurnCompleted = PubSub.publish(runtimeEventPubSub, {
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: PROVIDER,
      createdAt: CREATED_AT,
      threadId: THREAD,
      turnId: TURN,
      payload: { state: "completed" },
    } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);

    const dispatchLateSyntheticDiffComplete = engine
      .dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-late-diff-complete"),
        threadId: THREAD,
        turnId: TURN,
        completedAt: CREATED_AT,
        checkpointRef: checkpointRefForThreadTurn(THREAD, 1),
        status: "ready",
        files: [{ path: "hello-123.md", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: MessageId.make(`assistant:${TURN}`),
        checkpointTurnCount: 1,
        createdAt: CREATED_AT,
      })
      .pipe(Effect.orDie, Effect.asVoid);

    return {
      dispatchLateSyntheticDiffComplete,
      waitFor,
      dispatchAssistantMessage,
      dispatchTrailingTurnlessComplete,
      dispatchMarkerAssistantMessage,
      emitTurnStartedAndEdit,
      emitTurnCompleted,
    } satisfies HarnessApi;
  });

const testEffect = (run: (harness: HarnessApi) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const cwd = createGitRepository();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    yield* Effect.gen(function* () {
      const harness = yield* makeHarness(cwd, runtimeEventPubSub);
      yield* run(harness);
    }).pipe(Effect.provide(harnessLayer(cwd, runtimeEventPubSub)));
  }).pipe(Effect.scoped, TestClock.withLive);

describe("checkpoint ↔ assistant-message attachment (chat diff chip + revert)", () => {
  it.effect(
    "control: assistant message projected BEFORE completion → checkpoint references it",
    () =>
      testEffect((harness) =>
        Effect.gen(function* () {
          yield* harness.emitTurnStartedAndEdit;
          yield* harness.dispatchAssistantMessage;
          yield* harness.emitTurnCompleted;

          const thread = yield* harness.waitFor(
            (entry) => entry.checkpoints.some((checkpoint) => checkpoint.turnId === TURN),
            "turn checkpoint",
          );
          const checkpoint = thread.checkpoints.find((entry) => entry.turnId === TURN);
          assert.strictEqual(checkpoint?.assistantMessageId, REAL_ASSISTANT_MESSAGE);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "healing: assistant message projected only AFTER capture → the projection back-fills the real id",
    () =>
      testEffect((harness) =>
        Effect.gen(function* () {
          yield* harness.emitTurnStartedAndEdit;
          // The capture deterministically wins the race (the message lands
          // after); message-sent must re-attach the checkpoint.
          yield* harness.emitTurnCompleted;
          yield* harness.waitFor(
            (entry) => entry.checkpoints.some((checkpoint) => checkpoint.turnId === TURN),
            "turn checkpoint",
          );
          yield* harness.dispatchAssistantMessage;

          const thread = yield* harness.waitFor(
            (entry) => entry.messages.some((message) => message.id === REAL_ASSISTANT_MESSAGE),
            "assistant message",
          );
          const checkpoint = thread.checkpoints.find((entry) => entry.turnId === TURN);
          assert.strictEqual(checkpoint?.assistantMessageId, REAL_ASSISTANT_MESSAGE);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "INTENDED: a late checkpoint event carrying the synthetic id must NOT clobber the real attachment",
    () =>
      testEffect((harness) =>
        Effect.gen(function* () {
          yield* harness.emitTurnStartedAndEdit;
          // The other ordering: the assistant message is projected FIRST (real
          // id everywhere), and the reactor's diff-complete command — whose
          // payload was resolved from a projection that predated the message —
          // lands after.
          yield* harness.dispatchAssistantMessage;
          yield* harness.dispatchLateSyntheticDiffComplete;

          const thread = yield* harness.waitFor(
            (entry) => entry.checkpoints.some((checkpoint) => checkpoint.turnId === TURN),
            "turn checkpoint",
          );
          const checkpoint = thread.checkpoints.find((entry) => entry.turnId === TURN);
          // The chip/revert lookup is `checkpoint.assistantMessageId ∈ rendered
          // messages` — once the synthetic id overwrites the real one, the diff
          // is in the Diff panel but NEVER in chat, and revert is gone (no
          // later event re-heals it, so a reload shows the same broken state).
          assert.strictEqual(checkpoint?.assistantMessageId, REAL_ASSISTANT_MESSAGE);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "live 12:52 sequence: a turn-less TRAILING completion neither erases the message's turn nor detaches the checkpoint",
    () =>
      testEffect((harness) =>
        Effect.gen(function* () {
          yield* harness.emitTurnStartedAndEdit;
          // 12:52:41.692 — first completion, real turn binding.
          yield* harness.dispatchAssistantMessage;
          // 12:52:41.698 — the SAME messageId completed again with NO turnId
          // (the runtime's trailing segment close consumed after the turn
          // finalizer cleared the active marker).
          yield* harness.dispatchTrailingTurnlessComplete;
          // Fence: a later projected message proves the pipeline advanced past
          // the trailing completion.
          yield* harness.dispatchMarkerAssistantMessage;

          const threadAfterTrailing = yield* harness.waitFor(
            (entry) => entry.messages.some((message) => message.id === REAL_ASSISTANT_MESSAGE),
            "assistant message in projection",
          );
          const projectedMessage = threadAfterTrailing.messages.find(
            (message) => message.id === REAL_ASSISTANT_MESSAGE,
          );
          // 12:52:41.924 live showed turnId: null here — the clobber. "No
          // turnId" on a completion is no information; the binding must stay.
          assert.strictEqual(projectedMessage?.turnId, TURN);

          // 12:52:41.924 continued — with the binding intact, the checkpoint
          // capture must resolve the REAL message (resolvedFrom "projection",
          // not "synthetic"): chip + revert attach live, no reload needed.
          yield* harness.emitTurnCompleted;
          const thread = yield* harness.waitFor(
            (entry) => entry.checkpoints.some((checkpoint) => checkpoint.turnId === TURN),
            "turn checkpoint",
          );
          const checkpoint = thread.checkpoints.find((entry) => entry.turnId === TURN);
          assert.include(
            [REAL_ASSISTANT_MESSAGE, MARKER_ASSISTANT_MESSAGE],
            checkpoint?.assistantMessageId,
            "checkpoint must attach to a REAL projected message of the turn, never a synthetic id",
          );
        }),
      ),
    { timeout: 30_000 },
  );
});
