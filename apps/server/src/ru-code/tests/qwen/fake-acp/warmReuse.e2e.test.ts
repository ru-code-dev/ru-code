// ru-code: warm-engine v2 pool reuse over the REAL QwenAdapter + fake ACP
// agent:
//   - the DEFAULT instance boot-prewarms the generic pool at adapter create
//     (PREWARM_ON_EXPIRED > 0) — the very FIRST send of a fresh chat rides a
//     prewarmed process (take is spawn-free; the pool tops back up ONE process
//     at a time, `refillDelayMs` after each successful bind / warmup);
//   - with PREWARM_ON_EXPIRED = 0 (the shipped default) boot spawns NOTHING and
//     the first send is cold — the chain starts only once that bind proved the
//     recipe (T17);
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
import { pollForSpawns } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-reuse-thread");
const PREWARM = PREWARM_GENERIC_INSTANCES;
// ru-code (chained refill): the chain gap, tiny so the suite stays fast. Every
// spawn-count assertion is either "unchanged right now" (take is spawn-free) or
// a BOUNDED wait on the observed count — never a fixed sleep.
const REFILL_DELAY_MS = 50;
// ru-code (I8 — SPACING, not just the total): a chain of two or more links must
// be polled at its FIRST link too, or a pool that filled the bucket to target in
// ONE firing is invisible (the terminal count is identical either way). An
// intermediate exact poll must not swallow the NEXT legitimate link, so its
// quiet window is HALF a chain gap: a same-firing fan-out lands back-to-back
// (microseconds apart) and is caught, while the next legitimate link is a full
// chain gap PLUS the spare's warmup away and cannot land inside it.
const SPACING_QUIET_MS = REFILL_DELAY_MS / 2;

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
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      // Eager boot budget = the full generic target, so this suite keeps its
      // original subject (a chat riding a prewarmed process). The CHAIN is what
      // changed: one spawn now, the rest after each proof of health.
      poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
    });
    // Boot prewarm (default instance): the generic pool fills from CREATE —
    // one process at a time, before any chat exists.
    assert.strictEqual(spawnCount, 1, "the eager chain starts with exactly ONE process");
    yield* pollForSpawns(() => spawnCount, PREWARM, "boot chain reached the generic target");

    const deltas: string[] = [];
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        if (event.type === "content.delta") deltas.push(event.payload.delta);
      }),
    ).pipe(Effect.forkChild);

    // FIRST send of a fresh chat: takes a prewarmed spare (no cold boot),
    // binds via session/new, pool tops back up ONE process later.
    const beforeFirst = spawnCount;
    const firstSession = yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(spawnCount, beforeFirst, "take itself is spawn-free");
    assert.strictEqual(createSessionCount, 1, "the spare had NO session — one session/new");
    yield* pollForSpawns(() => spawnCount, PREWARM + 1, "the bind scheduled exactly one refill");

    yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "привет" })
      .pipe(Effect.timeout("10 seconds"));

    // Stop (idle), then restart with the persisted cursor: another spare is
    // taken and bound via session/load — full history preserved.
    yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
    const beforeRestart = spawnCount;
    yield* adapter
      .startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
      })
      .pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(spawnCount, beforeRestart, "restart take is spawn-free too");
    yield* pollForSpawns(() => spawnCount, PREWARM + 2, "the restart's bind refilled one");
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
      // A DEFAULT instance with this budget would have spawned at create — the
      // boot gate, not the eager budget, is what this test pins.
      poolOptions: { eagerOnExpired: PREWARM, refillDelayMs: REFILL_DELAY_MS },
    });
    assert.strictEqual(spawnCount, 0, "no boot prewarm for a non-default instance");
    // First start goes cold, then the CHAIN warms the pool for the next ones.
    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    assert.strictEqual(spawnCount, 1, "the cold spawn alone — the bind only SCHEDULES the refill");
    // ONE spare per firing: the first link lands ALONE (I8 spacing) …
    yield* pollForSpawns(
      () => spawnCount,
      2,
      "the chain's FIRST link spawned exactly one spare",
      SPACING_QUIET_MS,
    );
    // … and only then does the second link fill the bucket to target.
    yield* pollForSpawns(
      () => spawnCount,
      1 + PREWARM,
      "the chain filled to target after the bind",
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

// ── T17 — the shipped default: PREWARM_ON_EXPIRED = 0 ────────────────────────

it.effect(
  "T17 eagerOnExpired=0: boot spawns NOTHING, the first send is cold, then the chain fills one at a time",
  () => {
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
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: { eagerOnExpired: 0, refillDelayMs: REFILL_DELAY_MS },
      });
      // PREWARM_ON_EXPIRED = 0 ⇒ boot is EXPIRED and stays empty: no qwen
      // process (and therefore no `authenticate`, and no auth window) until a
      // chat actually needs one.
      assert.strictEqual(spawnCount, 0, "eager=0: adapter create spawns nothing");

      // The first send is COLD — the chat's own process starts instantly.
      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(spawnCount, 1, "one cold spawn; the bind only SCHEDULES the refill");
      assert.strictEqual(createSessionCount, 1, "one session/new for the cold start");
      // That bind is the proof of health ⇒ the chain adds spares one at a time:
      // the intermediate exact poll is what makes "one at a time" observable —
      // the terminal count alone is the same whether the bucket filled in one
      // firing or in two.
      yield* pollForSpawns(
        () => spawnCount,
        2,
        "the chain's FIRST link spawned exactly one spare",
        SPACING_QUIET_MS,
      );
      yield* pollForSpawns(() => spawnCount, 1 + PREWARM, "the chain filled to the generic target");
      const filled = spawnCount;

      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));

      // The next start rides a spare (spawn-free) and resumes via session/load.
      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: firstSession.resumeCursor,
        })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(spawnCount, filled, "the warm take is spawn-free");
      assert.deepStrictEqual(
        loadedSessionIds,
        [FAKE_SESSION_ID],
        "the pooled bind reconnected via session/load with the persisted cursor",
      );
      assert.strictEqual(createSessionCount, 1, "no second session/new — the resume loaded");
      yield* pollForSpawns(() => spawnCount, filled + 1, "the resume's bind refilled exactly one");
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

// ── T21 — the other first-class eager budget: PREWARM_ON_EXPIRED = 1 ─────────

it.effect(
  "T21 eagerOnExpired=1: boot warms exactly ONE process; the first send adopts it, then the chain fills",
  () => {
    let spawnCount = 0;
    let createSessionCount = 0;
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("ответ").respondOk(),
      onCreateSession: () => {
        createSessionCount += 1;
      },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: { eagerOnExpired: 1, refillDelayMs: REFILL_DELAY_MS },
      });
      // Exactly ONE eager process — one `authenticate`, so at most one auth
      // window can ever be open at boot.
      assert.strictEqual(spawnCount, 1, "eager=1: exactly one boot process");
      // …and the eager budget caps the chain there, however long we wait.
      yield* Effect.sleep("300 millis");
      assert.strictEqual(spawnCount, 1, "the eager budget caps the boot chain at 1");

      // The first send adopts that warm process (spawn-free take).
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.strictEqual(
        spawnCount,
        1,
        "the first send adopted the eager process — take is spawn-free",
      );
      assert.strictEqual(createSessionCount, 1, "the spare had NO session — one session/new");
      // The bind is the proof of health ⇒ the chain fills to the ACTIVE target,
      // ONE spare per firing (the take emptied the bucket, so this chain is two
      // links — the first one must land alone).
      yield* pollForSpawns(
        () => spawnCount,
        2,
        "the chain's FIRST link spawned exactly one spare",
        SPACING_QUIET_MS,
      );
      yield* pollForSpawns(() => spawnCount, 1 + PREWARM, "the chain filled to the generic target");
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));
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
