import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Processor } from "./processor.ts";

// No-op processor: satisfies the `Processor` seam so the server runs standalone
// before the real engine (Task 4) is wired. Every operation is a harmless void.
export const NoopProcessorLive = Layer.succeed(Processor, {
  start: Effect.void,
  notify: Effect.void,
  stop: Effect.void,
  runTickOnce: Effect.void,
});
