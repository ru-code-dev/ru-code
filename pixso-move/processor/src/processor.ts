import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// The processing engine, as seen by the server. The full implementation lands in
// Task 4; for now the server is wired to a no-op (see ./noop.ts) so it runs
// standalone — `notify` is what the ingest route calls after storing a node.
export interface ProcessorShape {
  readonly start: Effect.Effect<void>;
  readonly notify: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly runTickOnce: Effect.Effect<void>;
}

export class Processor extends Context.Service<Processor, ProcessorShape>()(
  "pixso-move/Processor",
) {}
