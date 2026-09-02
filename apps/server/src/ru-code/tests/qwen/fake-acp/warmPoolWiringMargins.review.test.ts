// ru-code (stage 4 REVIEW, round 2): W-P2's determinism margins, measured.
//
// W-P2 in `warmPoolWiring.e2e.test.ts` is a wall-clock test with absolute
// checkpoints. Its two tightest constraints are NOT asserted there, so this
// probe measures them directly on the same wiring:
//
//   M1  the pool must still be filling when the turn is dispatched — W-P2's
//       `at(700)` clamps to zero once the fill overran 700 ms, so what W-P2
//       actually needs is that the dispatch lands inside the FIRST idle window
//       (bind+1000, observed at the next sweep). Beyond that the idle reset
//       reaps first and CHECKPOINT A sees a legitimate reap.
//   M2  the turn's completion (touch #2) must land before the DISPATCH's idle
//       deadline (dispatch+1000 = bind+1700, again observed at the next sweep).
//       The turn ends at bind+1500, so the whole gate-open → finalizer → join
//       path has ~200 ms of slack.
//
// Both bounds below are the LAST instant at which W-P2 can still pass (the
// deadline plus one sweep, because a reap is only ever observed on a sweep
// tick): this probe must never fail where W-P2 passes. The measured values are
// a small fraction of either (see 4-reviewer-2.md D2).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollForSpawns } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-warm-margins-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-warm-margins-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/** W-P2's own numbers. */
const IDLE_RESET_MS = 1_000;
const IDLE_SWEEP_MS = 100;
const REFILL_DELAY_MS = 20;
const DISPATCH_AT_MS = 700;
const TURN_ENDS_AT_MS = 1_500;

it.effect("RW1 W-P2's two determinism margins are measured, not assumed", () => {
  let spawnCount = 0;
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
    yield* adapter
      .startSession({ threadId: THREAD_ID, cwd: process.cwd(), runtimeMode: "approval-required" })
      .pipe(Effect.timeout("10 seconds"));
    const boundAtMs = yield* Clock.currentTimeMillis;

    // M1 — the chain fill (with W-P2's 200 ms quiet window) against the
    // bind+700 dispatch point. Anything at or beyond 700 ms means W-P2's
    // `at(700)` fires LATE, and the idle reset at bind+1000 is next.
    yield* pollForSpawns(() => spawnCount, 3, "RW1 chain filled the generic pool", 200);
    const fillMs = (yield* Clock.currentTimeMillis) - boundAtMs;
    const fillBudgetMs = IDLE_RESET_MS + IDLE_SWEEP_MS;
    assert.isBelow(
      fillMs,
      fillBudgetMs,
      `M1: the chain fill + quiet window must finish inside the first idle window (${fillBudgetMs} ms), or the dispatch W-P2 schedules at bind+${DISPATCH_AT_MS} ms loses to the reap (measured ${fillMs} ms)`,
    );

    // M2 — the turn-completion path (gate open → finalizer touch → join).
    // W-P2 opens the gate at bind+1500 and touch #1's deadline is bind+1700.
    const turnFiber = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "долгий" })
      .pipe(Effect.timeout("20 seconds"), Effect.forkChild);
    yield* Effect.sleep("200 millis"); // let the turn actually start streaming
    const gateAtMs = yield* Clock.currentTimeMillis;
    yield* Deferred.succeed(turnGate, undefined);
    yield* Fiber.join(turnFiber);
    const completionMs = (yield* Clock.currentTimeMillis) - gateAtMs;
    const completionBudgetMs = IDLE_RESET_MS - (TURN_ENDS_AT_MS - DISPATCH_AT_MS) + IDLE_SWEEP_MS;
    assert.isBelow(
      completionMs,
      completionBudgetMs,
      `M2: gate-open → turn finalizer must fit in the ${completionBudgetMs} ms W-P2 leaves it (measured ${completionMs} ms)`,
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

// ── Vacuity checks for W-P2's two checkpoints ────────────────────────────────
// W-P2 asserts `disposeCount === 0` at bind+1300 and bind+2200. Those
// assertions only mean something if the sweeper WOULD have reaped by then
// without the touches. Both probes below drive the same wiring with one touch
// missing and show the reap landing BEFORE the checkpoint it protects — the
// non-destructive equivalent of the M-APP_A1 / M-APP_A2 mutations.

const IDLE_RESET_MS_2 = 1_000;
const CHECKPOINT_A_MS = 1_300;
const CHECKPOINT_B_MS = 2_200;

const wiringProbe = (
  label: string,
  body: (input: {
    readonly boundAtMs: number;
    readonly at: (offsetMs: number) => Effect.Effect<void>;
    readonly disposeCount: () => number;
    readonly dispatch: Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  it.effect(label, () => {
    let spawnCount = 0;
    let disposeCount = 0;
    const gate = Deferred.makeUnsafe<void>();
    const script: FakeAcpScript = {
      onPrompt: (steps) => steps.emitText("думаю…").awaitGate(gate).respondOk(),
    };
    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: {
          eagerOnExpired: 0,
          refillDelayMs: REFILL_DELAY_MS,
          idleResetMs: IDLE_RESET_MS_2,
          idleSweepMs: IDLE_SWEEP_MS,
        },
      });
      yield* adapter
        .startSession({ threadId: THREAD_ID, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      const boundAtMs = yield* Clock.currentTimeMillis;
      const at = (offsetMs: number) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(`${Math.max(0, boundAtMs + offsetMs - nowMs)} millis`);
        });
      yield* pollForSpawns(() => spawnCount, 3, `${label} chain filled`, 200);
      assert.strictEqual(disposeCount, 0, "nothing reaped while the pool is filling");
      const dispatch = adapter
        .sendTurn({ threadId: THREAD_ID, input: "долгий" })
        .pipe(Effect.timeout("20 seconds"), Effect.forkChild, Effect.asVoid);
      yield* body({ boundAtMs, at, disposeCount: () => disposeCount, dispatch });
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
  });

// No turn at all ⇒ no touch at all: the reap must already have happened when
// W-P2's CHECKPOINT A runs. This is what makes `disposeCount === 0` at +1300 a
// real assertion about touch #1.
wiringProbe(
  "RW2 with NO turn (no touch at all) the spares are reaped BEFORE W-P2's checkpoint A",
  ({ at, disposeCount }) =>
    Effect.gen(function* () {
      yield* at(CHECKPOINT_A_MS);
      assert.isAtLeast(
        disposeCount(),
        2,
        `without any touch the idle reset reaps both spares before bind+${CHECKPOINT_A_MS} ms`,
      );
    }),
);

// A turn dispatched at bind+700 that NEVER completes ⇒ touch #1 only. Its
// window closes at bind+1700, so the reap must already have happened when
// W-P2's CHECKPOINT B runs — which is what makes `disposeCount === 0` at +2200
// a real assertion about touch #2.
wiringProbe(
  "RW3 with touch #1 ONLY (the turn never completes) the reap lands BEFORE W-P2's checkpoint B",
  ({ at, disposeCount, dispatch }) =>
    Effect.gen(function* () {
      yield* at(DISPATCH_AT_MS);
      yield* dispatch;
      yield* at(CHECKPOINT_A_MS);
      assert.strictEqual(disposeCount(), 0, "touch #1 holds the spares past bind+1300");
      yield* at(CHECKPOINT_B_MS);
      assert.isAtLeast(
        disposeCount(),
        2,
        `touch #1 alone expires at bind+1700, so both spares are reaped before bind+${CHECKPOINT_B_MS} ms`,
      );
    }),
);

// The D1 fix must actually BITE: a count that is a lower bound but not the
// settled total has to die inside the quiet window. Same wiring, same helper,
// with `expected` deliberately one below the settled 3.
wiringProbe(
  "RW4 pollForSpawns DIES when the settled count exceeds `expected` (the D1 fix is not vacuous)",
  ({ disposeCount }) =>
    Effect.gen(function* () {
      void disposeCount;
      const outcome = yield* Effect.exit(
        pollForSpawns(() => 3, 2, "RW4 deliberate under-count", 200),
      );
      assert.isTrue(
        Exit.isFailure(outcome),
        "a settled count above `expected` must fail the helper, not pass it",
      );
    }),
);
