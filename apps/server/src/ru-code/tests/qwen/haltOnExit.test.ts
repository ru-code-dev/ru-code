// ru-code: coverage for haltOnExit — the stream operator that ends a child's
// stdio when the PROCESS EXITS (+ a short drain) instead of waiting for pipe EOF.
// The exit signal is `Effect.ignore`'d, so it settles the stream on exit success
// OR failure and never fails the stream itself.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { haltOnExit } from "@ru-code/qwen/haltOnExit";

// Stream.runCollect returns Array<A> directly in this effect build.
const collect = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream);

describe("haltOnExit", () => {
  it.effect("passes a finite stream through unchanged when exit never fires", () =>
    Effect.gen(function* () {
      // exitCode = Effect.never ⇒ the interrupt signal never settles, so the
      // finite source ends on its own EOF and every element is preserved.
      const source = Stream.make(1, 2, 3);
      const result = yield* collect(source.pipe(haltOnExit(Effect.never)));
      expect(result).toEqual([1, 2, 3]);
    }),
  );

  // it.live: haltOnExit sleeps EXIT_DRAIN_GRACE_MS after exit; the real clock
  // must advance for the interrupt to fire (it.effect's TestClock would hang).
  it.live("interrupts a never-ending stream once exit resolves (success)", () =>
    Effect.gen(function* () {
      // Source emits a bounded prefix then hangs. When exitCode succeeds the
      // operator interrupts (after the drain grace) and runCollect completes with
      // exactly the emitted prefix — proving it does not hang.
      const source = Stream.make("a", "b").pipe(Stream.concat(Stream.never));
      const result = yield* collect(source.pipe(haltOnExit(Effect.succeed(0))));
      expect(result).toEqual(["a", "b"]);
    }),
  );

  it.live("interrupts (not fails) the stream when exitCode FAILS", () =>
    Effect.gen(function* () {
      // exitCode failing must still only terminate the stream — Effect.ignore
      // swallows the failure, so runCollect succeeds rather than rejecting.
      const source = Stream.make("only").pipe(Stream.concat(Stream.never));
      const result = yield* collect(source.pipe(haltOnExit(Effect.fail("boom"))));
      expect(result).toEqual(["only"]);
    }),
  );
});
