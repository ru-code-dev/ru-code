// ru-fork: end-to-end error-engine tests. The REAL CliAdapter + AcpSessionRuntime
// run over the in-memory fake ACP agent (fakeAcpSpawner/fakeAcpCore), with the
// adapter's streamEvents wired into the REAL ProviderRuntimeIngestion + engine +
// projection. Each §E scenario drives a scripted wire failure and asserts the
// SETTLED projection — the contract the single writer must deliver:
//   - exactly one error timeline row bound to the real turnId (work-log keeps it);
//   - session.lastError set iff the surface is T+N (banner), else null;
//   - session.status error (T+N) / ready (T) and activeTurnId cleared (timer stops);
//   - the streamed assistant message finalized (streaming=false).
// Determinism comes from in-memory transport + single-consumer ingestion: the
// final projection is a pure function of the script. We poll the settled state
// (a condition, not a sleep).
// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CliSettings,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  type ProviderServiceShape,
  ThreadId,
} from "@t3tools/contracts";
import { CLI_NAME } from "@ru-fork/branding";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
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
import { makeCliAdapter } from "../../src/provider/Layers/CliAdapter.ts";
import { type CliAdapterShape } from "../../src/provider/Services/CliAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const INSTANCE_ID = ProviderInstanceId.make(CLI_NAME);

const CLI_SETTINGS: CliSettings = {
  enabled: true,
  binaryPath: CLI_NAME,
  homePath: "",
  launchArgs: "",
  customModels: [],
};

// Local tag so we can build the REAL adapter as a service and both (a) drive it
// directly and (b) feed its streamEvents into ingestion via a ProviderService.
class FakeCliAdapter extends Context.Service<FakeCliAdapter, CliAdapterShape>()(
  "test/FakeCliAdapter",
) {}

const makeProviderServiceFromAdapter = (adapter: CliAdapterShape): ProviderServiceShape => {
  const unsupported = () => Effect.die(new Error("unsupported in fake-acp harness")) as never;
  return {
    startSession: unsupported,
    sendTurn: unsupported,
    interruptTurn: unsupported,
    respondToRequest: unsupported,
    respondToUserInput: unsupported,
    stopSession: unsupported,
    stopAll: unsupported,
    hasParkedRequests: unsupported,
    listSessions: () => adapter.listSessions(),
    getCapabilities: () => Effect.succeed(adapter.capabilities),
    getInstanceInfo: unsupported,
    rollbackConversation: unsupported,
    get streamEvents() {
      return adapter.streamEvents;
    },
  };
};

type ReadModel = OrchestrationReadModel;
type Thread = ReadModel["threads"][number];

const tempDirs: string[] = [];
let scope: Scope.Closeable | null = null;
let runtime: ManagedRuntime.ManagedRuntime<
  | OrchestrationEngineService
  | ProviderRuntimeIngestionService
  | ProjectionSnapshotQuery
  | FakeCliAdapter,
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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createHarness(
  script: FakeAcpScript,
  opts?: { readonly sessionStartTimeoutMs?: number },
) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-error-engine-"));
  tempDirs.push(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, ".git"));

  const adapterLayer = Layer.effect(
    FakeCliAdapter,
    // ru-fork #4: opts.sessionStartTimeoutMs is passed through to the real adapter so a
    // "hang" start trips the timeout in ms. Until the adapter wires the option it is
    // ignored at runtime (the test then fails by hitting its own guard — TDD red).
    makeCliAdapter(CLI_SETTINGS, {
      instanceId: INSTANCE_ID,
      ...(opts?.sessionStartTimeoutMs !== undefined
        ? { sessionStartTimeoutMs: opts.sessionStartTimeoutMs }
        : {}),
    }),
  ).pipe(Layer.provide(fakeAcpSpawnerLayer(script)));

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
  const providerServiceLayer = Layer.effect(
    ProviderService,
    Effect.map(Effect.service(FakeCliAdapter), makeProviderServiceFromAdapter),
  );

  const layer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(providerServiceLayer),
    Layer.provideMerge(adapterLayer),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provideMerge(NodeServices.layer),
  );

  runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
  const adapter = await runtime.runPromise(Effect.service(FakeCliAdapter));
  scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));

  const createdAt = "2026-01-01T00:00:00.000Z";
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Error Engine Project",
      workspaceRoot,
      defaultModelSelection: { instanceId: INSTANCE_ID, model: "qwen" },
      createdAt,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      modelSelection: { instanceId: INSTANCE_ID, model: "qwen" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );

  const readModel = () => runtime!.runPromise(snapshotQuery.getSnapshot());
  const drain = () => runtime!.runPromise(ingestion.drain);

  return { adapter, engine, snapshotQuery, readModel, drain, workspaceRoot };
}

async function waitForThread(
  readModel: () => Promise<ReadModel>,
  predicate: (thread: Thread) => boolean,
  timeoutMs = 5000,
): Promise<Thread> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  for (;;) {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
    if (thread && predicate(thread)) return thread;
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(
        `Timed out waiting for thread state; last: ${JSON.stringify(thread?.session)} activities=${thread?.activities.length}`,
      );
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
}

const startSession = (adapter: CliAdapterShape, cwd: string) =>
  adapter.startSession({ threadId: THREAD_ID, cwd, runtimeMode: "approval-required" });

const sendTurn = (adapter: CliAdapterShape, input?: string) =>
  adapter.sendTurn({
    threadId: THREAD_ID,
    ...(input !== undefined ? { input } : {}),
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  });

const errorActivity = (thread: Thread) =>
  thread.activities.find((activity) => activity.tone === "error" && activity.kind === "provider.turn.start.failed");

const assistantStreamingStuck = (thread: Thread) =>
  thread.messages.some((message) => message.role === "assistant" && message.streaming === true);

describe("cliAdapterErrorEngine", () => {
  // ── Group 1: wire-inducible failures (real adapter prompt.fail → ingestion) ──

  it("C4 — broken pipe mid-stream: T+N banner, persisting timeline row, timer stopped", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.emitText("partial").closeTransport(),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    const activity = errorActivity(thread)!;
    expect(activity.payload).toMatchObject({ detail: expect.stringContaining("Соединение") });
    expect(activity.turnId).not.toBeNull();
    expect(thread.latestTurn?.turnId).toBe(activity.turnId); // work-log keeps the row
    expect(thread.session?.status).toBe("error"); // T+N
    expect(thread.session?.lastError).toContain("Соединение"); // banner
    expect(assistantStreamingStuck(thread)).toBe(false); // timer stopped
  });

  it("A5 — auth required (RPC -32000): T+N banner, no streamed message", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(-32000, "auth required"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).not.toBeNull();
    expect(assistantStreamingStuck(thread)).toBe(false);
  });

  it("A4 — protocol invalid (RPC -32601): T only, timeline row but NO banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(-32601, "method not found"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(errorActivity(thread)).toBeDefined(); // timeline row present
    expect(thread.session?.status).toBe("ready"); // T: no error status
    expect(thread.session?.lastError ?? null).toBeNull(); // T: NO banner
  });

  it("A6 — resource not found (RPC -32002): T only, timeline row but NO banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(-32002, "resource not found"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(errorActivity(thread)).toBeDefined();
    expect(thread.session?.status).toBe("ready"); // T
    expect(thread.session?.lastError ?? null).toBeNull(); // no banner
  });

  it("B1 — process exit mid-turn (exit 1): T+N, streamed message finalized", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.emitText("partial answer").exit(1),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(thread.session?.lastError).not.toBeNull(); // T+N banner
    expect(assistantStreamingStuck(thread)).toBe(false); // timer stopped
  });

  it("C1 — malformed protocol frame: T+N", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.emitText("hi").writeRaw("}{ not json\n"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(thread.session?.lastError).not.toBeNull();
    expect(assistantStreamingStuck(thread)).toBe(false);
  });

  it("A1 — empty response (B surface): turn COMPLETES with friendly bubble, no banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", {
          details: "Model stream ended with empty response text",
        }),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    const result = await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    expect(Exit.isSuccess(result)).toBe(true); // B: turn completes, sendTurn succeeds
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError ?? null).toBeNull();
    expect(errorActivity(thread)).toBeUndefined(); // no error row (turn completed)
    expect(assistantStreamingStuck(thread)).toBe(false);
  });

  it("A2 — rate limit (RPC 429, B surface): turn COMPLETES, no banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(429, "rate limit"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    const result = await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    expect(Exit.isSuccess(result)).toBe(true);
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError ?? null).toBeNull();
    expect(errorActivity(thread)).toBeUndefined();
  });

  it("A3 — generic -32603 with details (B surface): turn COMPLETES, no banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    const result = await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    expect(Exit.isSuccess(result)).toBe(true);
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null,
    );
    expect(thread.session?.lastError ?? null).toBeNull();
    expect(errorActivity(thread)).toBeUndefined();
  });

  it("A7 — slash command unsupported (B surface): turn COMPLETES, no banner", async () => {
    const harness = await createHarness({
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    const result = await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    expect(Exit.isSuccess(result)).toBe(true);
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null,
    );
    expect(thread.session?.lastError ?? null).toBeNull();
    expect(errorActivity(thread)).toBeUndefined();
  });

  it("Z — unrecognized clean request error: T+N banner with the detail verbatim", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondError(-32050, "Понятная ошибка из движка"),
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(thread.session?.status).toBe("error"); // T+N
    expect(thread.session?.lastError).not.toBeNull(); // banner carries the detail
  });

  // ── Group 3: adapter-input failures (no wire) ──

  it("D1 — empty prompt parts (validation): T only, no banner", async () => {
    const harness = await createHarness({ onPrompt: (steps) => steps.respondOk() });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter))); // no input → D1
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null && errorActivity(thread) !== undefined,
    );
    expect(thread.session?.status).toBe("ready"); // T
    expect(thread.session?.lastError ?? null).toBeNull(); // no banner
  });

  it("D2 — no live session (requireSession fails after turn.started): T only", async () => {
    const harness = await createHarness({ onPrompt: (steps) => steps.respondOk() });
    // No startSession → requireSession fails inside sendTurn (after turn.started).
    await Effect.runPromise(Effect.exit(sendTurn(harness.adapter, "hello")));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => errorActivity(thread) !== undefined,
    );
    expect(errorActivity(thread)).toBeDefined();
    expect(thread.session?.lastError ?? null).toBeNull(); // D2 is T
  });

  // ── Stop: user cancel, not error ──

  it("Stop — interruptTurn while a turn is in flight: cancelled, no banner, timer stopped", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.emitText("working..."), // no terminal → held prompt
    });
    await Effect.runPromise(startSession(harness.adapter, harness.workspaceRoot));
    // Fork the held turn, wait until it is running, then Stop it.
    const turnFiber = Effect.runFork(Effect.exit(sendTurn(harness.adapter, "hello")));
    await waitForThread(harness.readModel, (thread) => thread.session?.activeTurnId != null);
    await Effect.runPromise(harness.adapter.interruptTurn(THREAD_ID));
    await Effect.runPromise(Fiber.await(turnFiber));
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (thread) => thread.session?.activeTurnId == null,
    );
    expect(thread.session?.lastError ?? null).toBeNull(); // cancel clears/omits error
    expect(thread.session?.status).not.toBe("error");
    expect(assistantStreamingStuck(thread)).toBe(false);
    expect(errorActivity(thread)).toBeUndefined(); // not a failure
  });

  // ── Group 4: inner CLI start timeout (ru-fork #4) ──
  // A wedged `cli --acp` boot must FAIL the start (so the reactor's overlay finalizer
  // fires) instead of hanging forever. These drive the REAL adapter over the fake.

  it("G7 — start handshake HANG → typed start error within the timeout (NOT a hang)", async () => {
    const harness = await createHarness(
      { onPrompt: (steps) => steps.respondOk(), startBehavior: "hang" },
      { sessionStartTimeoutMs: 50 },
    );
    // Guard the call so red (no timeout wired) fails fast at 2s instead of hanging the suite.
    const outcome = await Effect.runPromise(
      startSession(harness.adapter, harness.workspaceRoot).pipe(
        Effect.matchCause({
          onFailure: (cause) => ({ kind: "failed" as const, message: Cause.pretty(cause) }),
          onSuccess: () => ({ kind: "established" as const }),
        }),
        Effect.timeoutOrElse({
          duration: Duration.millis(2000),
          orElse: () => Effect.succeed({ kind: "guard-timeout" as const }),
        }),
      ),
    );
    // GREEN once the adapter wires the start timeout: a typed failure mentioning the
    // unresponsive handshake. RED today: production never times out ⇒ "guard-timeout".
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toMatch(/start handshake|unresponsive/i);
    }
  });

  it("G8 — start handshake ERROR settles as a typed failure (no hang)", async () => {
    const harness = await createHarness({
      onPrompt: (steps) => steps.respondOk(),
      startBehavior: "error",
    });
    const exit = await Effect.runPromise(
      Effect.exit(startSession(harness.adapter, harness.workspaceRoot)),
    );
    expect(Exit.isFailure(exit)).toBe(true); // a start RPC error must surface, not hang
  });
});
