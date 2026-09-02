// ru-code: shared fake-ACP test primitives — ONE poll idiom and ONE adapter
// event collector for the whole suite (three competing poll/wait shapes with
// divergent timeout semantics was audit finding C7).
import { type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

/**
 * Live-clock poll on a condition that must be READ effectfully — a file on
 * disk, a service call (callers run under TestClock.withLive). A timeout is a
 * broken test EXPECTATION, so it DIES (an outer Effect.exit must never absorb
 * it into a green "typed failure" assertion).
 */
export const pollUntilEffect = (predicate: Effect.Effect<boolean>, label: string) =>
  Effect.gen(function* () {
    while (!(yield* predicate)) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.die(new Error(`pollUntil(${label}) timed out`)),
    }),
  );

/**
 * The sync special case of `pollUntilEffect` — the SAME bounded wait and the
 * same die-on-timeout semantics, for a condition an observer already recorded
 * in a local variable. (One poll idiom for the whole suite: a condition that
 * must be READ effectfully — a file on disk, a service call — uses
 * `pollUntilEffect` rather than a fourth wait shape.)
 */
export const pollUntil = (predicate: () => boolean, label: string) =>
  pollUntilEffect(Effect.sync(predicate), label);

/**
 * ru-code (chained warm refill): the pool no longer spawns inline, so a spawn
 * count is reached asynchronously (`poolOptions.refillDelayMs` after each proof
 * of health). Bounded wait on the OBSERVED count — never a bare sleep as the
 * only synchronization; a timeout DIES like every other broken expectation.
 *
 * SETTLE-AND-ASSERT-EXACT: a `>=` wait alone is a LOWER bound, and a lower
 * bound cannot see the failure this suite exists to catch — a chain that fans
 * out and spawns several processes where the policy allows one. So after the
 * count is reached the helper stays quiet for `quietMs` (default 2× the chain
 * gaps this suite uses) and then asserts the count is EXACTLY `expected`:
 * anything the chain still had queued would have landed inside that window.
 */
export const pollForSpawns = (
  observed: () => number,
  expected: number,
  label: string,
  quietMs = 120,
) =>
  Effect.gen(function* () {
    yield* pollUntil(() => observed() >= expected, `${label} — spawns >= ${expected}`);
    yield* Effect.sleep(`${quietMs} millis`);
    const settled = observed();
    if (settled !== expected) {
      return yield* Effect.die(
        new Error(
          `pollForSpawns(${label}): expected EXACTLY ${expected} spawns, observed ${settled} after a ${quietMs} ms quiet period`,
        ),
      );
    }
  });

export interface AdapterEventCollector {
  /** Every runtime event delivered so far, in order. */
  readonly events: ProviderRuntimeEvent[];
  /** Resolves once a content.delta containing `marker` was delivered. */
  readonly waitForDelta: (marker: string) => Effect.Effect<void>;
  /** Interrupt the collector fiber (end of test). */
  readonly stop: Effect.Effect<void>;
}

/**
 * Fork a collector over `adapter.streamEvents`. The delta waiters replace the
 * per-test "streaming" Deferred boilerplate; `events` replaces the ad-hoc
 * arrays.
 */
export const collectAdapterEvents = (adapter: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const deltaWaiters = new Map<string, Deferred.Deferred<void>>();
    const waiterFor = (marker: string) => {
      const existing = deltaWaiters.get(marker);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      deltaWaiters.set(marker, created);
      return created;
    };
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
        if (event.type === "content.delta") {
          for (const [marker, waiter] of deltaWaiters) {
            if (event.payload.delta.includes(marker)) {
              Deferred.doneUnsafe(waiter, Effect.void);
            }
          }
        }
      }),
    ).pipe(Effect.forkChild);
    const collector: AdapterEventCollector = {
      events,
      waitForDelta: (marker) =>
        Effect.suspend(() => {
          // Late registration still resolves: check delivered events first.
          if (
            events.some(
              (event) => event.type === "content.delta" && event.payload.delta.includes(marker),
            )
          ) {
            return Effect.void;
          }
          return Deferred.await(waiterFor(marker));
        }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.die(new Error(`waitForDelta(${marker}) timed out`)),
          }),
        ),
      stop: Effect.asVoid(Fiber.interrupt(fiber)),
    };
    return collector;
  });
