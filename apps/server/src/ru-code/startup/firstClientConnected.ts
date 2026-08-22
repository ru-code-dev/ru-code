// ru-code (boot performance, Fix W): "a client has connected" as a service. Backed by ONE
// Deferred<void> — `signal` is idempotent (completing a completed Deferred is a no-op), so
// every ws attach may call it unconditionally; `awaited` resolves once the first signal
// lands and immediately for every later caller. Consumers that must not run before a
// client exists (warm-pool prewarm) await it instead of watching sockets themselves.
// The service is OPTIONAL for consumers (resolve via `Effect.serviceOption`): a context
// without the layer keeps the consumer's pre-deferral behavior.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export interface FirstClientConnectedShape {
  /** Mark "first client connected". Idempotent — safe to call on every attach. */
  readonly signal: Effect.Effect<void>;
  /** Resolves once `signal` has been called at least once; never fails. */
  readonly awaited: Effect.Effect<void>;
}

export class FirstClientConnected extends Context.Service<
  FirstClientConnected,
  FirstClientConnectedShape
>()("t3/ru-code/startup/firstClientConnected") {}

const makeFirstClientConnected = Effect.gen(function* () {
  const connected = yield* Deferred.make<void>();
  return {
    signal: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
    awaited: Deferred.await(connected),
  } satisfies FirstClientConnectedShape;
});

export const FirstClientConnectedLive = Layer.effect(
  FirstClientConnected,
  makeFirstClientConnected,
);

/**
 * `signal` when the service is in context, no-op when it is not — the ws route calls
 * this unconditionally so test harnesses without the layer keep working unchanged.
 */
export const signalFirstClientConnected: Effect.Effect<void> = Effect.serviceOption(
  FirstClientConnected,
).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.void,
      onSome: (service) => service.signal,
    }),
  ),
);
