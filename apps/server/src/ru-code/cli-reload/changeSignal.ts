// ru-code (cli-reload): a condition variable in its smallest honest form.
//
// The reload's kill pass is a fixpoint over state owned by two other modules — the live-child
// registry and the spawn scheduler. It must not poll them: re-testing in a spin re-runs the whole
// kill pass (every `stopAll`, the pool-mutex drain, `killAll`) at memory speed inside an
// uninterruptible unit, which is exactly what adversary R3-1 measured (~145k iterations/s while
// one granted client had simply not spawned yet).
//
// So each owner publishes ONE change signal instead. The shape is the classic condition variable:
// a `Deferred<void>` that every mutation COMPLETES and REPLACES. A waiter takes the current
// handle BEFORE it reads the state; any mutation after that point completes the handle it is
// already holding, so a change landing between the read and the await cannot be lost. There is no
// timeout and no clock anywhere in it (R6, R9) — a wake-up is always caused by a real state
// change, never by time passing.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export interface ChangeSignal {
  /**
   * The handle the NEXT mutation will complete. Take it BEFORE reading the state you are
   * waiting on — that ordering is what makes the wait lost-wakeup free.
   */
  readonly next: Effect.Effect<Deferred.Deferred<void>>;
  /** Announce a mutation: complete the outstanding handle and install a fresh one. */
  readonly signalUnsafe: () => void;
  /** Tests only — drop any handle a previous test left outstanding. */
  readonly resetUnsafe: () => void;
}

export const makeChangeSignal = (): ChangeSignal => {
  let current = Deferred.makeUnsafe<void>();
  const signalUnsafe = (): void => {
    const outstanding = current;
    // Replace before completing. NOT OBSERVABLE under this runtime — a woken waiter resumes
    // through the scheduler, never reentrantly inside `doneUnsafe`, so the opposite order passes
    // every spec too (mutation M37, knowingly masked). It is written this way so the invariant
    // "the handle you are woken from is never the handle you take next" holds by construction
    // rather than by the scheduler's good manners.
    current = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(outstanding, Effect.void);
  };
  return {
    next: Effect.sync(() => current),
    signalUnsafe,
    resetUnsafe: () => {
      signalUnsafe();
      current = Deferred.makeUnsafe<void>();
    },
  };
};
