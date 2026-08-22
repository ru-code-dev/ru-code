// ru-code (boot performance, Fix W): the prewarm-trigger decision QwenAdapter delegates to.
// With FirstClientConnected in context the generic prewarm must NOT run until the first
// client signal, and must run exactly once after it (idempotent signal included). Without
// the service the legacy behavior holds: prewarm awaited inline at the call site. All
// settling is deferred-based — no timers anywhere.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { triggerGenericPrewarm } from "../../qwen/warmPrewarmTrigger.ts";
import {
  FirstClientConnected,
  FirstClientConnectedLive,
  signalFirstClientConnected,
} from "../../startup/firstClientConnected.ts";

describe("triggerGenericPrewarm", () => {
  it.effect("with FirstClientConnected: no prewarm until signal, exactly one after", () =>
    Effect.gen(function* () {
      let prewarmRuns = 0;
      const prewarmSettled = yield* Deferred.make<void>();
      const prewarm = Effect.gen(function* () {
        prewarmRuns += 1;
        yield* Deferred.succeed(prewarmSettled, undefined);
      }).pipe(Effect.asVoid);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* triggerGenericPrewarm(prewarm, scope);
          // The trigger returned (adapter creation would proceed) with zero prewarms:
          // the forked fiber is parked on the first-client deferred.
          expect(prewarmRuns).toBe(0);

          const firstClient = yield* Effect.service(FirstClientConnected);
          yield* firstClient.signal;
          yield* Deferred.await(prewarmSettled);
          expect(prewarmRuns).toBe(1);

          // A second signal is a no-op on the completed deferred — no second prewarm.
          yield* firstClient.signal;
          expect(prewarmRuns).toBe(1);
        }),
      );
    }).pipe(Effect.provide(FirstClientConnectedLive)),
  );

  it.effect("without the service: prewarm is awaited inline (legacy behavior)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let prewarmRuns = 0;
        const prewarm = Effect.sync(() => {
          prewarmRuns += 1;
        });
        const scope = yield* Effect.scope;
        yield* triggerGenericPrewarm(prewarm, scope);
        // Inline await ⇒ already completed by the time the trigger returns.
        expect(prewarmRuns).toBe(1);
      }),
    ),
  );

  it.effect("signal-before-trigger: an already-connected client prewarms without waiting", () =>
    Effect.gen(function* () {
      let prewarmRuns = 0;
      const prewarmSettled = yield* Deferred.make<void>();
      const prewarm = Effect.gen(function* () {
        prewarmRuns += 1;
        yield* Deferred.succeed(prewarmSettled, undefined);
      }).pipe(Effect.asVoid);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const firstClient = yield* Effect.service(FirstClientConnected);
          yield* firstClient.signal; // client attached before the adapter was built
          const scope = yield* Effect.scope;
          yield* triggerGenericPrewarm(prewarm, scope);
          yield* Deferred.await(prewarmSettled);
          expect(prewarmRuns).toBe(1);
        }),
      );
    }).pipe(Effect.provide(FirstClientConnectedLive)),
  );

  // The ws-route side of the wiring: `signalFirstClientConnected` releases parked
  // consumers when the layer is present, and is a plain no-op when it is not.
  it.effect("signalFirstClientConnected releases a parked prewarm through the shared layer", () =>
    Effect.gen(function* () {
      let prewarmRuns = 0;
      const prewarmSettled = yield* Deferred.make<void>();
      const prewarm = Effect.gen(function* () {
        prewarmRuns += 1;
        yield* Deferred.succeed(prewarmSettled, undefined);
      }).pipe(Effect.asVoid);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* triggerGenericPrewarm(prewarm, scope);
          expect(prewarmRuns).toBe(0);

          yield* signalFirstClientConnected; // what the ws route runs after markConnected
          yield* Deferred.await(prewarmSettled);
          expect(prewarmRuns).toBe(1);
        }),
      );
    }).pipe(Effect.provide(FirstClientConnectedLive)),
  );

  it.effect(
    "signalFirstClientConnected without the layer is a no-op",
    () => signalFirstClientConnected,
  );
});
