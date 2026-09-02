// ru-code: warm-engine STOP coverage (acp-process-pool §2.2) over the REAL
// QwenAdapter + in-memory fake ACP agent:
//   (a) a mid-stream Stop settles the turn instantly (turn.completed{cancelled}
//       then session.exited) BEFORE any SIGKILL, and the fake received the
//       graceful session/cancel;
//   (b) a CLI that ignores session/cancel still gets SIGKILLed after the grace
//       by the detached background teardown — the settle stays instant;
//   (c) an idle-session stop keeps today's path: no cancel, immediate kill;
//   (d) an immediate same-thread re-send awaits the teardown latch (old child
//       killed BEFORE the new spawn) and resumes via session/load;
//   (e) the delayed "starting" feedback fires during startSession and precedes
//       "ready" (delay 0 pins the emission deterministically).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-cancel-then-kill-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-cancel-then-kill-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Poll a condition into determinism (live clock; bounded by the timeout).
const awaitCondition = (check: () => boolean, what: string) => pollUntil(check, what);

it.effect(
  "qwen stop (a): mid-stream Stop settles instantly — cancel sent, events before any kill",
  () => {
    let cancelCount = 0;
    let killCount = 0;
    const script: FakeAcpScript = {
      onCancel: () => {
        cancelCount += 1;
      },
      // Parked prompt: streams one chunk, resolves only on session/cancel
      // (fakeAcpCore's cancel behavior) — a genuine in-flight turn.
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      // Long grace: proves the settle path never waits on it (I-11) — were the
      // settle coupled to the kill, the polls below would time out.
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
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
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "do work" }),
      );
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));

      yield* awaitCondition(
        () =>
          cancelCount === 1 &&
          events.some((e) => e.type === "turn.completed") &&
          events.some((e) => e.type === "session.exited"),
        "cancel received + turn.completed + session.exited delivered",
      );
      yield* Fiber.interrupt(eventsFiber);

      // Instant settle: the turn/session settled while the background teardown
      // is still inside its 5s grace — no SIGKILL has fired yet.
      assert.strictEqual(killCount, 0, "settle happened before any SIGKILL (detached grace)");
      const completion = events.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed",
      );
      assert.strictEqual(completion!.payload.state, "cancelled");
      // Ordering: turn.completed strictly before session.exited (I5).
      assert.isBelow(
        events.findIndex((e) => e.type === "turn.completed"),
        events.findIndex((e) => e.type === "session.exited"),
      );
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onKill: () => {
              killCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop (b): a cancel-ignoring CLI is SIGKILLed after the grace, settle stays instant",
  () => {
    let killCount = 0;
    const script: FakeAcpScript = {
      // No onCancel handler override needed — the fake's parked prompt resolves
      // on cancel regardless; "ignoring" here means the CHILD never exits, so
      // only the grace expiry can end it.
      onPrompt: (steps) => steps.emitText("working..."),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 100 });
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
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "do work" }),
      );
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));

      // The settle already happened (join returned); the background teardown
      // must deliver the SIGKILL once the 100ms grace expires.
      yield* awaitCondition(() => killCount >= 1, "background SIGKILL after the grace");
      yield* awaitCondition(
        () =>
          events.some((e) => e.type === "turn.completed") &&
          events.some((e) => e.type === "session.exited"),
        "settle events delivered",
      );
      yield* Fiber.interrupt(eventsFiber);
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onKill: () => {
              killCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop (c): an idle-session stop keeps today's path — no cancel, immediate kill",
  () => {
    let cancelCount = 0;
    let killCount = 0;
    const script: FakeAcpScript = {
      onCancel: () => {
        cancelCount += 1;
      },
      onPrompt: (steps) => steps.respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), { cancelGraceMs: 5_000 });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.stopSession(THREAD_ID).pipe(Effect.timeout("10 seconds"));

      // Idle teardown is inline: by the time stopSession returned, the SIGKILL
      // already fired — no grace, no cancel, no latch.
      assert.isAtLeast(killCount, 1, "idle stop SIGKILLs inline");
      assert.strictEqual(cancelCount, 0, "idle stop never sends session/cancel");
      yield* awaitCondition(
        () => events.some((e) => e.type === "session.exited"),
        "session.exited delivered",
      );
      yield* Fiber.interrupt(eventsFiber);
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onKill: () => {
              killCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen stop (d): an immediate same-thread re-send awaits the teardown latch, then resumes via session/load",
  () => {
    const order: string[] = [];
    const loadedSessionIds: string[] = [];
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("working..."),
      onLoadSession: (sessionId) => {
        loadedSessionIds.push(sessionId);
      },
    };
    const spawnCount = () => order.filter((entry) => entry === "spawn").length;
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        cancelGraceMs: 100,
        // ru-code (warm engine v2.1): the boot spares and every refill now
        // arrive ONE at a time, `refillDelayMs` after each proof of health —
        // so each stage is settled with a bounded wait before the next act,
        // which is what makes the kill/spawn ORDER below deterministic.
        poolOptions: { eagerOnExpired: 2, refillDelayMs: 50 },
      });
      const streaming = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" && event.payload.delta.includes("working")
          ? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* awaitCondition(() => spawnCount() >= 2, "the boot chain filled the generic pool");

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* awaitCondition(() => spawnCount() >= 3, "the first start's chained refill landed");
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "do work" }),
      );
      yield* Deferred.await(streaming).pipe(Effect.timeout("10 seconds"));

      yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));

      // Immediate re-send INSIDE the teardown window: must await the latch
      // (old child killed first), then reconnect via session/load.
      yield* adapter
        .startSession({
          threadId: THREAD_ID,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: firstSession.resumeCursor,
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* awaitCondition(() => spawnCount() >= 4, "the re-send's chained refill landed");
      yield* Fiber.interrupt(eventsFiber);
      // Latch ordering: the old child died BEFORE the re-send proceeded. With
      // the v2.1 pool: 2 chained boot spares, the first start takes one and its
      // bind chains a refill (+1), the stop's background teardown kills the old
      // child (the latch), and the re-send takes a spare and chains one more —
      // the kill sits strictly before the last spawn.
      assert.deepStrictEqual(order, ["spawn", "spawn", "spawn", "kill", "spawn"]);
      assert.deepStrictEqual(
        loadedSessionIds,
        [FAKE_SESSION_ID],
        "re-send resumed via session/load",
      );
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              order.push("spawn");
            },
            onKill: () => {
              order.push("kill");
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);

it.effect(
  "qwen feedback (e): the starting state is emitted during startSession and precedes ready",
  () => {
    const script: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };
    const PROBE_THREAD_ID = ThreadId.make("qwen-feedback-probe-thread");
    return Effect.gen(function* () {
      // The starting feedback is emitted inline at startSession entry (0ms,
      // race-free via the preserve-modes seam).
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const states: string[] = [];
      let probeObserved = false;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.threadId === PROBE_THREAD_ID) {
            probeObserved = true;
            return;
          }
          if (event.type === "session.state.changed") {
            states.push(event.payload.state);
          }
        }),
      ).pipe(Effect.forkChild);
      // The starting event fires at startSession ENTRY (0ms). Production
      // subscribes at instance boot, long before any start; here a PROBE
      // start proves the subscriber is attached (its later lifecycle events
      // are only deliverable to an attached subscriber) before the thread
      // under test starts — deterministic, no attach-sleep.
      yield* adapter.startSession({
        threadId: PROBE_THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* awaitCondition(() => probeObserved, "probe events delivered (subscriber attached)");

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* awaitCondition(() => states.includes("ready"), "ready state delivered");
      yield* Fiber.interrupt(eventsFiber);

      assert.include(states, "starting", "starting feedback emitted");
      assert.isBelow(
        states.indexOf("starting"),
        states.indexOf("ready"),
        "starting precedes ready",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);
