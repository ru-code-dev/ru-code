import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ShutdownSignalShape {
  readonly request: Effect.Effect<void>;
  readonly await: Effect.Effect<void>;
}

export class ShutdownSignal extends Context.Service<ShutdownSignal, ShutdownSignalShape>()(
  "t3/shutdownSignal",
) {}
