// ru-code: a one-shot signal a node event handler can fire and an Effect can await.
//
// Every timeout spec in this folder runs under the TestClock, where the ONLY thing that moves time
// is an explicit `TestClock.adjust`. That makes "wait until the server actually has the request"
// impossible to express as a sleep — a sleep would either not advance at all, or advance the very
// clock the test is trying to control. A promise resolved by the server's own event is
// clock-independent, so it is the one honest way to order the two.

/** A promise plus the idempotent `fire` that settles it (node may emit `close` more than once). */
export interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly fire: () => void;
}

export const deferredSignal = (): DeferredSignal => {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = () => {
      resolve();
    };
  });
  return { promise, fire: () => settle() };
};
