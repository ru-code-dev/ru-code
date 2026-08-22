// ru-code (boot performance, Fix W): WHEN the warm pool's generic prewarm runs. The real
// qwen CLI boot is heavy; prewarming during server boot competes with the first client's
// connect + snapshot serve. So with `FirstClientConnected` in context the prewarm is
// FORKED onto the caller's scope and gated on the first client signal — never awaited at
// adapter creation, and NO timers. Without the service (unit harnesses, bespoke runtimes)
// the prewarm is awaited inline, exactly the pre-Fix-W behavior.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { FirstClientConnected } from "../startup/firstClientConnected.ts";

export const triggerGenericPrewarm = (
  prewarm: Effect.Effect<void>,
  forkScope: Scope.Scope,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const firstClient = yield* Effect.serviceOption(FirstClientConnected);
    if (Option.isNone(firstClient)) {
      // Service absent ⇒ inline await at creation (legacy behavior, nothing else changes).
      yield* prewarm;
      return;
    }
    // Fiber lifetime = the caller's scope (the adapter layer scope): an adapter
    // rebuild/shutdown before any client connects interrupts the parked fiber.
    yield* firstClient.value.awaited.pipe(
      Effect.flatMap(() => prewarm),
      Effect.forkIn(forkScope),
    );
  });
