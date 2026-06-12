import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { haltOnExit } from "../src/ru-fork/spawn/haltOnExit.ts";

// A stream that emits a known prefix then blocks forever (Stream.never),
// modelling a child whose pipe never reaches EOF.
const prefixThenHang = Stream.concat(Stream.make("a", "b", "c"), Stream.never);

it.live("ends on exit + drain and keeps the prefix (runFold)", () =>
  Effect.gen(function* () {
    const out = yield* prefixThenHang.pipe(
      haltOnExit(Effect.void),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    assert.strictEqual(out, "abc");
  }),
);

it.live("works with a mutable accumulator (runForEach)", () =>
  Effect.gen(function* () {
    let acc = "";
    const halted = prefixThenHang.pipe(haltOnExit(Effect.void));
    yield* Stream.runForEach(halted, (chunk) =>
      Effect.sync(() => {
        acc += chunk;
      }),
    );
    assert.strictEqual(acc, "abc");
  }),
);

it.live("works with an effectful fold (runFoldEffect)", () =>
  Effect.gen(function* () {
    const out = yield* prefixThenHang.pipe(
      haltOnExit(Effect.void),
      Stream.runFoldEffect(
        () => "",
        (acc, chunk) => Effect.succeed(acc + chunk),
      ),
    );
    assert.strictEqual(out, "abc");
  }),
);

it.live("a failing exit signal still settles the stream (Effect.ignore)", () =>
  Effect.gen(function* () {
    const out = yield* prefixThenHang.pipe(
      haltOnExit(Effect.fail("boom")),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    assert.strictEqual(out, "abc");
  }),
);
