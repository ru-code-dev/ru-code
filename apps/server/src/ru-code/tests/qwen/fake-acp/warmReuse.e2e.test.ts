// ru-code: warm-engine v2 pool reuse over the REAL QwenAdapter + fake ACP
// agent:
//   - the DEFAULT instance boot-prewarms the generic pool at adapter create —
//     the very FIRST send of a fresh chat rides a prewarmed process (take is
//     spawn-free; the pool tops back up);
//   - a non-default instance spawns nothing at create (pools lazily);
//   - stop + restart takes another spare and reconnects via session/load with
//     the persisted cursor; the pooled session streams turns normally;
//   - gate-off spot check (I-6): with `warmEngine: false` the adapter shows
//     the classic behavior exactly — no prewarm, one spawn, zero cancels.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  QwenSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PREWARM_GENERIC_INSTANCES } from "@ru-code/qwen/constants";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-reuse-thread");
const PREWARM = PREWARM_GENERIC_INSTANCES;

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-warm-reuse-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("boot prewarm + reuse: first send is warm, restart is warm, session/load resumes", () => {
  let spawnCount = 0;
  const loadedSessionIds: string[] = [];
  let createSessionCount = 0;
  const script: FakeAcpScript = {
    onPrompt: (steps) => steps.emitText("ответ").respondOk(),
    onCreateSession: () => {
      createSessionCount += 1;
    },
    onLoadSession: (sessionId) => {
      loadedSessionIds.push(sessionId);
    },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    // Boot prewarm (default instance): the generic pool fills at CREATE —
    // before any chat exists.
    assert.strictEqual(spawnCount, PREWARM, "adapter create prewarmed the generic target");

    const deltas: string[] = [];
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        if (event.type === "content.delta") deltas.push(event.payload.delta);
      }),
    ).pipe(Effect.forkChild);

    // FIRST send of a fresh chat: takes a prewarmed spare (no cold boot),
    // binds via session/new, pool tops back up.
    const firstSession = yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(spawnCount, PREWARM + 1, "take is spawn-free; +1 is the top-up");
    assert.strictEqual(createSessionCount, 1, "the spare had NO session — one session/new");

    yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "привет" })
      .pipe(Effect.timeout("10 seconds"));

    // Stop (idle), then restart with the persisted cursor: another spare is
    // taken and bound via session/load — full history preserved.
    yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
    yield* adapter
      .startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
      })
      .pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(spawnCount, PREWARM + 2, "restart take is spawn-free; +1 is the top-up");
    assert.deepStrictEqual(
      loadedSessionIds,
      [FAKE_SESSION_ID],
      "the pooled bind reconnected via session/load with the persisted cursor",
    );
    assert.strictEqual(createSessionCount, 1, "no second session/new — the resume loaded");

    // The pooled session streams like any other.
    const before = deltas.length;
    yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "снова привет" })
      .pipe(Effect.timeout("10 seconds"));
    const streamed = yield* Effect.gen(function* () {
      while (deltas.length <= before) {
        yield* Effect.sleep("10 millis");
      }
      return true;
    }).pipe(Effect.timeout("5 seconds"));
    assert.isTrue(streamed, "the pooled session streamed the second turn");
    yield* Fiber.interrupt(eventsFiber);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(script, {
          onSpawn: () => {
            spawnCount += 1;
          },
        }),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

it.effect("a NON-default instance does not boot-prewarm (pools lazily on first use)", () => {
  let spawnCount = 0;
  const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      instanceId: ProviderInstanceId.make("qwen-second"),
    });
    assert.strictEqual(spawnCount, 0, "no boot prewarm for a non-default instance");
    // First start goes cold, then the pool warms for the next ones.
    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(spawnCount, 1 + PREWARM, "cold spawn + post-success top-up to target");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(script, {
          onSpawn: () => {
            spawnCount += 1;
          },
        }),
        testServices,
      ),
    ),
    TestClock.withLive,
  );
});

it.effect(
  "gate off (I-6): warmEngine=false keeps today's exact behavior — 1 spawn, 0 cancels",
  () => {
    let spawnCount = 0;
    let cancelCount = 0;
    const script: FakeAcpScript = {
      onCancel: () => {
        cancelCount += 1;
      },
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { warmEngine: false });
      assert.strictEqual(spawnCount, 0, "gate off: no boot prewarm");
      const events: ProviderRuntimeEvent[] = [];
      const streaming = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "content.delta" && event.payload.delta.includes("working")
              ? Deferred.succeed(streaming, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(spawnCount, 1, "gate off: one cold spawn, no refill");

      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "do work" }),
      );
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));
      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));

      const settled = () =>
        events.some((e) => e.type === "turn.completed") &&
        events.some((e) => e.type === "session.exited");
      yield* Effect.gen(function* () {
        while (!settled()) {
          yield* Effect.sleep("10 millis");
        }
      }).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(cancelCount, 0, "gate off: Stop is today's bare force-kill, no cancel");
      assert.strictEqual(spawnCount, 1, "gate off: still exactly one spawn");
      const completion = events.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed",
      );
      assert.strictEqual(completion!.payload.state, "cancelled");
      // Gate off ⇒ no starting feedback either.
      assert.isUndefined(
        events.find((e) => e.type === "session.state.changed" && e.payload.state === "starting"),
        "gate off: no starting feedback event",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);
