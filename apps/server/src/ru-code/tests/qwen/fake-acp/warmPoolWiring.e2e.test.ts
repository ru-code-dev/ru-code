// ru-code: the adapter→warm-pool WIRING that every other fake-ACP suite hides
// behind its own `poolOptions`. Two subjects, both invisible to the rest of the
// suite:
//
//   W-P1 the PRODUCTION constants. Every chain suite passes its own
//        `eagerOnExpired`/`refillDelayMs` (it must — a 5 s gap would make them
//        slow), so nothing checks that an adapter created with NO poolOptions
//        at all actually gets PREWARM_ON_EXPIRED = 0 and PREWARM_DELAY_MS =
//        5 s. Those two constants are the whole "no auth window at boot, one
//        `authenticate` at a time" promise on a user's machine.
//
//   W-P2 the two `warmPool.touch` call sites (turn dispatch + turn finalizer).
//        The package proves `pool.touch` pushes the idle deadline; nothing
//        proved the ADAPTER calls it, because no suite runs a small enough
//        `idleResetMs` for the window to matter. Here it is ~1 s, so a long
//        turn straddles it: the spares must survive both the dispatch and the
//        completion window, and only then be reaped by the idle reset.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { PREWARM_DELAY_MS, PREWARM_ON_EXPIRED } from "@ru-code/qwen/constants";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollForSpawns, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-wiring-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-warm-wiring-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The observation window for "nothing spawned". It must stay far below
// PREWARM_DELAY_MS so the assertion is about the CONSTANT and not about how
// fast this machine is.
const NO_SPAWN_WINDOW_MS = 1_000;

// ── W-P1 — the production constants, with NO poolOptions seam at all ─────────

it.effect(
  "W-P1 production constants: no poolOptions ⇒ boot spawns 0 and no refill lands within 1 s",
  () => {
    let spawnCount = 0;
    const script: FakeAcpScript = { onPrompt: (steps) => steps.emitText("ответ").respondOk() };
    return Effect.gen(function* () {
      // Guard the premise: this test only means something while the shipped
      // constants really are "nothing at boot" and "a gap far above the window".
      assert.strictEqual(PREWARM_ON_EXPIRED, 0, "PREWARM_ON_EXPIRED must ship as 0");
      assert.isAbove(
        PREWARM_DELAY_MS,
        NO_SPAWN_WINDOW_MS * 2,
        "PREWARM_DELAY_MS must ship far above this test's observation window",
      );

      // NO poolOptions: exactly what QwenDriver passes in production.
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      assert.strictEqual(spawnCount, 0, "PREWARM_ON_EXPIRED = 0: adapter create spawns nothing");
      yield* Effect.sleep(`${NO_SPAWN_WINDOW_MS} millis`);
      assert.strictEqual(spawnCount, 0, "…and nothing spawns later either — boot stays empty");

      // The first chat is cold, and its bind is the proof of health that arms
      // the chain — which must then WAIT PREWARM_DELAY_MS (5 s), not fire.
      yield* adapter
        .startSession({ threadId: THREAD_ID, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      assert.strictEqual(spawnCount, 1, "one cold spawn for the chat's own session");
      yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "привет" })
        .pipe(Effect.timeout("10 seconds"));
      yield* Effect.sleep(`${NO_SPAWN_WINDOW_MS} millis`);
      assert.strictEqual(
        spawnCount,
        1,
        "PREWARM_DELAY_MS: the refill is scheduled, not spawned — nothing within 1 s",
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

// ── W-P2 — both `warmPool.touch` call sites, through the real adapter ────────

// A ~1 s idle window, swept 10×/s, with a chain gap small enough that the
// spares exist almost immediately. Every checkpoint below is an ABSOLUTE
// deadline measured from the bind, so scheduler jitter cannot slide them.
const IDLE_RESET_MS = 1_000;
const IDLE_SWEEP_MS = 100;
const REFILL_DELAY_MS = 20;
/** Turn dispatched late in the first idle window (touch #1 must move it). */
const DISPATCH_AT_MS = 700;
/** Checkpoint A: past the ORIGINAL deadline (1000), before the dispatch's (1700). */
const CHECKPOINT_A_MS = 1_300;
/** The turn's response finishes here (touch #2). */
const TURN_ENDS_AT_MS = 1_500;
/** Checkpoint B: past the dispatch's deadline (1700), before the completion's (2500). */
const CHECKPOINT_B_MS = 2_200;
/** Past the completion's deadline + one sweep: the spares must be reaped now. */
const REAP_DEADLINE_MS = 2_800;

it.effect(
  "W-P2 a long turn keeps the spares alive across BOTH touch windows, then the idle reset reaps them",
  () => {
    let spawnCount = 0;
    let disposeCount = 0;
    // The turn's response parks here until the test opens it — the turn's
    // duration is by construction, not by a wall-clock race.
    const turnGate = Deferred.makeUnsafe<void>();
    const script: FakeAcpScript = {
      onPrompt: (steps) =>
        steps.emitText("думаю…").awaitGate(turnGate).emitText("готово").respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: {
          eagerOnExpired: 0,
          refillDelayMs: REFILL_DELAY_MS,
          idleResetMs: IDLE_RESET_MS,
          idleSweepMs: IDLE_SWEEP_MS,
        },
      });
      assert.strictEqual(spawnCount, 0, "eager=0: boot spawns nothing");

      // The cold start binds (proof of health) — the clock for every deadline
      // below starts HERE, because the bind is the last pool activity that
      // does not go through `warmPool.touch`.
      yield* adapter
        .startSession({ threadId: THREAD_ID, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      // Every checkpoint is an absolute deadline measured from the bind (the
      // clock is LIVE here — `TestClock.withLive` wraps the whole test), so a
      // slow step cannot slide the later checkpoints out of their windows.
      const boundAtMs = yield* Clock.currentTimeMillis;
      const at = (offsetMs: number) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(`${Math.max(0, boundAtMs + offsetMs - nowMs)} millis`);
        });

      // The chain fills the generic pool: the chat's own child + 2 spares.
      yield* pollForSpawns(() => spawnCount, 3, "the chain filled the generic pool", 200);
      assert.strictEqual(disposeCount, 0, "nothing reaped while the pool is filling");

      // A turn is dispatched LATE in the first idle window. Touch #1
      // (sendTurnInternal, before `turn.started`) must move the deadline from
      // `bound + 1000` to `dispatch + 1000`.
      yield* at(DISPATCH_AT_MS);
      const turnFiber = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "долгий" })
        .pipe(Effect.timeout("20 seconds"), Effect.forkChild);

      // CHECKPOINT A — past the ORIGINAL deadline, while the turn still
      // streams. Without touch #1 the sweeper has already killed the spares.
      yield* at(CHECKPOINT_A_MS);
      assert.strictEqual(
        disposeCount,
        0,
        "touch #1 (turn dispatch): a turn in flight keeps the spares alive past the original window",
      );

      // The response finishes ⇒ touch #2 (the turn finalizer) runs.
      yield* at(TURN_ENDS_AT_MS);
      yield* Deferred.succeed(turnGate, undefined);
      yield* Fiber.join(turnFiber);

      // CHECKPOINT B — past the DISPATCH's deadline. Only the finalizer's
      // touch can still be holding the spares.
      yield* at(CHECKPOINT_B_MS);
      assert.strictEqual(
        disposeCount,
        0,
        "touch #2 (turn finalizer): completing the turn re-armed the idle window",
      );

      // …and with the chat now silent, the idle reset really does fire: both
      // spares are killed and reaped (the chat's OWN child is not — the
      // session owns it).
      yield* at(REAP_DEADLINE_MS);
      yield* pollUntil(() => disposeCount >= 2, "the idle reset reaped both generic spares");
      assert.strictEqual(spawnCount, 3, "eager=0: the expired pool respawns nothing");
      assert.strictEqual(yield* adapter.hasSession(THREAD_ID), true, "the chat's session survives");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawnCount += 1;
            },
            onDispose: () => {
              disposeCount += 1;
            },
          }),
          testServices,
        ),
      ),
      TestClock.withLive,
    );
  },
);
