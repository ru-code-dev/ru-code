// ru-fork: ingestion-level guarantees for the single-writer error engine that
// the wire harness (cliAdapterErrorEngine) can't exercise in isolation:
//   - §9.4 ordering (I5): turn.completed{failed} ingested BEFORE session.exited
//     ⇒ the banner's lastError is preserved (not blanked) and the streamed
//     message is finalized (timer stops) — the cache-strip race is closed.
//   - Group 4 (NOT wire-inducible): D3 (other Provider* error) + E (defect) are
//     server-side; covered by a synthesized turn.completed{failed} into ingestion
//     plus a pure classify() seam test.
// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderServiceShape,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { CLI_NAME } from "@ru-fork/branding";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../src/persistence/Layers/Sqlite.ts";
import { ProviderService } from "../../src/provider/Services/ProviderService.ts";
import { RepositoryIdentityResolverLive } from "../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../src/config.ts";
import { ServerSettingsService } from "../../src/serverSettings.ts";
import { classify, UNRECOGNIZED_DECISION } from "../../src/ru-fork/cli-errors-handling/recognizers.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const INSTANCE_ID = ProviderInstanceId.make(CLI_NAME);
const TURN_ID = TurnId.make("11111111-1111-1111-1111-111111111111");

type ReadModel = OrchestrationReadModel;
type Thread = ReadModel["threads"][number];

const tempDirs: string[] = [];
let scope: Scope.Closeable | null = null;
let runtime: ManagedRuntime.ManagedRuntime<
  OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
  unknown
> | null = null;

afterEach(async () => {
  if (scope) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
  }
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let eventSeq = 0;
const stamp = () => ({
  eventId: EventId.make(`evt-${eventSeq++}`),
  provider: CLI_NAME as ProviderRuntimeEvent["provider"],
  providerInstanceId: INSTANCE_ID,
  createdAt: "2026-01-01T00:00:01.000Z",
  threadId: THREAD_ID,
});

async function createHarness() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ee-ingest-"));
  tempDirs.push(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, ".git"));

  const runtimeEventPubSub = await Effect.runPromise(PubSub.unbounded<ProviderRuntimeEvent>());
  const unsupported = () => Effect.die(new Error("unsupported")) as never;
  const providerService: ProviderServiceShape = {
    startSession: unsupported,
    sendTurn: unsupported,
    interruptTurn: unsupported,
    respondToRequest: unsupported,
    respondToUserInput: unsupported,
    stopSession: unsupported,
    stopAll: unsupported,
    hasParkedRequests: unsupported,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: unsupported,
    rollbackConversation: unsupported,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const layer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
  runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
  scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));

  const createdAt = "2026-01-01T00:00:00.000Z";
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId: PROJECT_ID,
      title: "P",
      workspaceRoot,
      defaultModelSelection: { instanceId: INSTANCE_ID, model: "qwen" },
      createdAt,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "T",
      modelSelection: { instanceId: INSTANCE_ID, model: "qwen" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );

  const emit = (event: ProviderRuntimeEvent) =>
    runtime!.runPromise(PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid));
  const drain = () => runtime!.runPromise(ingestion.drain);
  const readModel = () => runtime!.runPromise(snapshotQuery.getSnapshot());
  return { emit, drain, readModel };
}

async function waitForThread(
  readModel: () => Promise<ReadModel>,
  predicate: (thread: Thread) => boolean,
  timeoutMs = 5000,
): Promise<Thread> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  for (;;) {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (thread && predicate(thread)) return thread;
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`timeout; session=${JSON.stringify(thread?.session)}`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
}

const errorActivity = (thread: Thread) =>
  thread.activities.find((activity) => activity.tone === "error" && activity.kind === "provider.turn.start.failed");
const streamingStuck = (thread: Thread) =>
  thread.messages.some((message) => message.role === "assistant" && message.streaming === true);

const turnStarted = (): Extract<ProviderRuntimeEvent, { type: "turn.started" }> => ({
  ...stamp(),
  type: "turn.started",
  turnId: TURN_ID,
  payload: { model: undefined },
});
const assistantDelta = (delta: string): Extract<ProviderRuntimeEvent, { type: "content.delta" }> => ({
  ...stamp(),
  type: "content.delta",
  turnId: TURN_ID,
  payload: { delta, streamKind: "assistant_text" },
});
const turnFailed = (
  errorMessage: string,
  showNotification: boolean,
): Extract<ProviderRuntimeEvent, { type: "turn.completed" }> => ({
  ...stamp(),
  type: "turn.completed",
  turnId: TURN_ID,
  payload: { state: "failed", stopReason: "failed", errorMessage, showNotification },
});
const sessionExited = (): Extract<ProviderRuntimeEvent, { type: "session.exited" }> => ({
  ...stamp(),
  type: "session.exited",
  payload: { exitKind: "graceful" },
});

describe("errorEngineIngestion", () => {
  it("§9.4 — turn.completed{failed} then session.exited: lastError preserved, message finalized (I5)", async () => {
    const harness = await createHarness();
    harness.emit(turnStarted());
    harness.emit(assistantDelta("partial answer")); // a streaming assistant bubble
    harness.emit(turnFailed("Соединение с Cli потеряно.", true));
    harness.emit(sessionExited()); // offered AFTER the failure — single consumer applies in order
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "stopped" && errorActivity(thread) !== undefined,
    );
    // session.exited preserved the banner set by turn.completed{failed} (not blanked)
    expect(thread.session?.lastError).toContain("Соединение");
    // the streamed message was finalized BEFORE the exited-cache-strip → timer stopped
    expect(streamingStuck(thread)).toBe(false);
    // timeline row bound to the real turn id, persists
    const activity = errorActivity(thread)!;
    expect(activity.turnId).toBe(TURN_ID);
  });

  it("Group 4 — D3/E synthesized failed turn (surface T): timeline row, no banner", async () => {
    const harness = await createHarness();
    harness.emit(turnStarted());
    harness.emit(turnFailed("Внутренняя ошибка провайдера. Подробности в журнале сервера.", false));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(errorActivity(thread)!.turnId).toBe(TURN_ID); // row present + bound
    expect(thread.session?.status).toBe("ready"); // T: no error status
    expect(thread.session?.lastError ?? null).toBeNull(); // T: NO banner
  });

  it("classify — defect cause → E (T, killAcp); Provider* tag → D3 (T, killAcp)", () => {
    const dieDecision = classify(undefined, Cause.die(new Error("sync throw")));
    expect(dieDecision?.id).toBe("E");
    expect(dieDecision?.surface).toBe("T");
    expect(dieDecision?.killAcp).toBe(true);

    const providerError = { _tag: "ProviderSomethingElseError", message: "x" };
    const d3 = classify(providerError, Cause.fail(providerError)) ?? UNRECOGNIZED_DECISION;
    expect(d3.id).toBe("D3");
    expect(d3.surface).toBe("T");
    expect(d3.killAcp).toBe(true);
  });
});
