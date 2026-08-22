// ru-code: the wall-clock deadline that makes "the UI cannot show work that is not happening" a
// property of the design rather than of every future edit.
//
// A check and an install both REPLY as soon as their work is under way, so nobody is awaiting the
// fiber that finishes it. Two things have to hold for that to be safe:
//
//   · the work must END — `Effect.ensuring` only helps if the fiber terminates, and not every step
//     inside carries a budget of its own (`extractTarball` spawns `tar` with none);
//   · when it ends without a verdict, the state must say so.
//
// Both live here, in one place, so a step added later inherits them without anyone remembering to.
// Extracted from the engine rather than written inline so the guarantee itself can be tested against
// an effect that genuinely never completes — which is the only way to prove a backstop works, since
// while every inner step IS bounded the deadline correctly never fires.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface DeadlineParams<A, E, R> {
  /** The work to bound. */
  readonly work: Effect.Effect<A, E, R>;
  readonly durationMs: number;
  /** Named in the log line when the deadline fires — "check round" / "install run". */
  readonly label: string;
  /** What to answer with when the deadline fires. The work has already been interrupted. */
  readonly onTimeout: Effect.Effect<A>;
  /**
   * Runs on EVERY exit — success, typed failure, defect and interruption alike. Its job is to make
   * the state truthful about work that is no longer happening; it must be idempotent, because the
   * normal path reaches it too.
   */
  readonly settle: Effect.Effect<void>;
}

/**
 * Bound `work` and guarantee `settle` runs afterwards, whatever happened.
 *
 * Order matters: `ensuring` is applied OUTSIDE the timeout, so a deadline that interrupts the work
 * still lands in the finalizer. Reversed, an interrupted fiber could skip it.
 */
export const withDeadline = <A, E, R>(params: DeadlineParams<A, E, R>): Effect.Effect<A, E, R> =>
  params.work.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(params.durationMs),
      orElse: () =>
        Effect.logError(`[auto-update] ${params.label} exceeded its deadline`).pipe(
          Effect.andThen(params.onTimeout),
        ),
    }),
    Effect.ensuring(params.settle),
  );
