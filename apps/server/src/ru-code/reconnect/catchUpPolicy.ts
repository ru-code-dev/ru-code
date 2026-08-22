// ru-code: reconnect catch-up policy (boot-performance.md S1).
//
// A resubscribing client passes `afterSequence`; the handlers used to replay the
// event tail behind it UNBOUNDED — the mechanism behind the field reconnect loop
// (production-error.md §5). This policy is the single decision point: a small gap
// replays events (cheap, incremental), a stale cursor is served the same full
// snapshot frame the cold path already produces — bounded either way.
import * as Effect from "effect/Effect";

/**
 * Largest event gap worth replaying. Measured on the reference machine a
 * 500-row catch-up page costs 20-132 ms depending on payload size
 * (reconnectHotPathsScale.perf.test.ts); 2 000 events keeps the worst replay in
 * the low hundreds of ms while any legitimate reconnect gap (seconds to minutes
 * of missed events) stays far below it.
 */
export const CATCH_UP_GAP_THRESHOLD = 2_000;

export type CatchUpPlan = "replay" | "snapshot";

/** Decide replay-vs-snapshot for one resubscribe; the snapshot fallback is logged. */
export const decideCatchUpPlan = Effect.fn("ruCode.reconnect.decideCatchUpPlan")(function* (input: {
  readonly endpoint: string;
  readonly afterSequence: number;
  readonly currentSequence: number;
}) {
  const gap = input.currentSequence - input.afterSequence;
  if (gap <= CATCH_UP_GAP_THRESHOLD) {
    return "replay" as const satisfies CatchUpPlan;
  }
  yield* Effect.logDebug("[reconnect] catch-up gap over threshold — serving a snapshot instead", {
    endpoint: input.endpoint,
    afterSequence: input.afterSequence,
    currentSequence: input.currentSequence,
    gap,
    threshold: CATCH_UP_GAP_THRESHOLD,
  });
  return "snapshot" as const satisfies CatchUpPlan;
});
