// ru-code: the RPC entry/exit trace. It exists because the failure that started the
// analytics rework produced ZERO server log lines — indistinguishable from "the request
// never arrived". Pins the two properties that matter:
//   1. TRANSPARENCY — the wrapper never alters the effect's outcome (value, error, or
//      interruption pass through untouched);
//   2. the exit branch is recorded for all three outcomes, including interruption, which
//      must read as "interrupted" (a closed socket is normal here), never as "failure".

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";

import { traceAnalyticsRpc } from "../../analytics/analyticsRpcHandlers.ts";

// Repo diagnostics forbid a bare global Error in an Effect failure channel.
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly note: string }> {}

/**
 * Run `effect` under a capturing logger; returns the log messages AND the full `Exit`.
 *
 * The exit is returned whole, not reduced to its `_tag`: a tag proves only that something
 * failed or succeeded, so a wrapper that quietly remapped the success VALUE or replaced the
 * typed error with a lookalike would satisfy it. Transparency is the property this file
 * exists to pin, and it lives in the payload.
 */
const captureLogs = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<{ readonly logs: ReadonlyArray<unknown>; readonly exit: Exit.Exit<A, E> }> =>
  Effect.gen(function* () {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    const exit = yield* effect.pipe(
      Effect.provide(
        Logger.layer([logger], { mergeWithExisting: false }).pipe(
          // The trace logs at DEBUG (the standing log-level rule); without raising the
          // minimum level the runtime filters the lines before the logger ever sees them.
          Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
        ),
      ),
      Effect.exit,
    );
    return { logs, exit };
  });

const outcomeOf = (logs: ReadonlyArray<unknown>): unknown => {
  const end = logs.find(
    (message): message is [string, Record<string, unknown>] =>
      Array.isArray(message) && message[0] === "[analytics] rpc end",
  );
  return end?.[1]?.["outcome"];
};

const startLogged = (logs: ReadonlyArray<unknown>): boolean =>
  logs.some((message) => Array.isArray(message) && message[0] === "[analytics] rpc start");

describe("traceAnalyticsRpc", () => {
  it.effect("success: value passes through untouched, outcome logged as success", () =>
    Effect.gen(function* () {
      let observed: number | null = null;
      const { logs, exit } = yield* captureLogs(
        traceAnalyticsRpc(
          "analytics.getSnapshot",
          Effect.sync(() => 42).pipe(Effect.tap((value) => Effect.sync(() => (observed = value)))),
        ),
      );
      assert.strictEqual(exit._tag, "Success");
      // The value the CALLER receives, not merely the one the inner effect produced.
      assert.deepStrictEqual(exit, Exit.succeed(42));
      assert.strictEqual(observed, 42);
      assert.isTrue(startLogged(logs));
      assert.strictEqual(outcomeOf(logs), "success");
    }),
  );

  it.effect("failure: the error passes through untouched, outcome logged as failure", () =>
    Effect.gen(function* () {
      const failure = new TestFailure({ note: "disk on fire" });
      const { logs, exit } = yield* captureLogs(
        traceAnalyticsRpc("analytics.refresh", Effect.fail(failure)),
      );
      assert.strictEqual(exit._tag, "Failure");
      // The EXACT typed error reaches the caller — not a re-wrapped lookalike.
      if (exit._tag !== "Failure") throw new Error("unreachable");
      // `findErrorOption` (not `findError`, which wraps in a Result) — the typed error is
      // present, and it is the SAME instance the handler failed with.
      const surfaced = Option.getOrNull(Cause.findErrorOption(exit.cause));
      assert.strictEqual(surfaced, failure);
      assert.strictEqual(surfaced?.note, "disk on fire");
      assert.isTrue(startLogged(logs));
      assert.strictEqual(outcomeOf(logs), "failure");
    }),
  );

  it.effect("interruption is logged as interrupted, NOT as failure", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      // The fork must provably REACH the wrapped effect before the interrupt lands, or
      // the fiber dies before its first step and nothing was ever there to log.
      const started = yield* Deferred.make<void>();
      const fiber = yield* traceAnalyticsRpc(
        "analytics.refresh",
        Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
      ).pipe(
        Effect.provide(
          Logger.layer([logger], { mergeWithExisting: false }).pipe(
            Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      // `Fiber.interrupt` resolves to void here — the outcome is read from the fiber.
      const exit = yield* Fiber.await(fiber);
      // Interruption stays interruption all the way out: no defect, no synthesized error.
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag !== "Failure") throw new Error("unreachable");
      assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.isTrue(startLogged(logs));
      assert.strictEqual(outcomeOf(logs), "interrupted");
    }),
  );
});
