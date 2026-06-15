import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { NoopProcessorLive, Processor } from "../src/index.ts";

it.effect("no-op processor runs every operation without effect", () =>
  Effect.gen(function* () {
    const processor = yield* Processor;
    yield* processor.start;
    yield* processor.notify;
    yield* processor.runTickOnce;
    yield* processor.stop;
    assert.ok(true);
  }).pipe(Effect.provide(NoopProcessorLive)),
);
