// ru-code: the slow-serve trace (boot-performance.md Fix D). Contract: a serve
// above SLOW_SERVE_THRESHOLD_MILLIS emits exactly ONE debug line carrying the
// endpoint, duration and the summarizer's fields; a fast serve emits nothing.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import { withSlowServeLog } from "../../reconnect/slowServeLog.ts";

const makeCapture = () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    if (Array.isArray(message)) {
      messages.push(...message);
    } else {
      messages.push(message);
    }
  });
  const layer = Layer.mergeAll(
    Logger.layer([logger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Debug"), // capture logDebug
  );
  return { messages, layer };
};

const slowServeRecords = (messages: ReadonlyArray<unknown>) =>
  messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && "endpoint" in message,
  );

describe("withSlowServeLog", () => {
  it.effect("a serve above the threshold emits exactly one line with the fields", () => {
    const { messages, layer } = makeCapture();
    return Effect.gen(function* () {
      const serveFiber = yield* Effect.forkChild(
        Effect.sleep("1500 millis").pipe(
          Effect.as({ rows: 7 }),
          withSlowServeLog("test.endpoint", (value) => ({ rows: value.rows })),
        ),
      );
      yield* TestClock.adjust("1500 millis");
      const served = yield* Fiber.join(serveFiber);
      expect(served).toEqual({ rows: 7 });

      expect(messages).toContain("[reconnect] slow snapshot serve");
      const records = slowServeRecords(messages);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        endpoint: "test.endpoint",
        durationMs: 1500,
        rows: 7,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a fast serve emits nothing", () => {
    const { messages, layer } = makeCapture();
    return Effect.gen(function* () {
      const served = yield* Effect.succeed({ rows: 3 }).pipe(
        withSlowServeLog("test.endpoint", (value) => ({ rows: value.rows })),
      );
      expect(served).toEqual({ rows: 3 });
      expect(slowServeRecords(messages)).toHaveLength(0);
      expect(messages).not.toContain("[reconnect] slow snapshot serve");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a serve exactly AT the threshold stays quiet (strictly-over contract)", () => {
    const { messages, layer } = makeCapture();
    return Effect.gen(function* () {
      const serveFiber = yield* Effect.forkChild(
        Effect.sleep("1000 millis").pipe(
          Effect.asVoid,
          withSlowServeLog("test.endpoint", () => ({})),
        ),
      );
      yield* TestClock.adjust("1000 millis");
      yield* Fiber.join(serveFiber);
      expect(slowServeRecords(messages)).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
