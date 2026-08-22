/**
 * ru-code (boot performance, Fix D): the field-diagnosable trace for slow
 * snapshot serves. Every reconnect-loop instrument this program pinned starts
 * as "a snapshot serve took seconds while the pinger needed milliseconds" —
 * but production logs showed only the resulting `Interrupt`. This helper makes
 * the CAUSE loggable: any wrapped serve that takes longer than the threshold
 * emits one `logDebug` line with the endpoint, the id, what was served (row /
 * approximate byte counts from the caller's summarizer) and the duration.
 * Fast serves emit nothing.
 *
 * @module ru-code/reconnect/slowServeLog
 */
import type { OrchestrationShellSnapshot, OrchestrationThread } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const SLOW_SERVE_THRESHOLD_MILLIS = 1_000;

/**
 * Thread-detail summary: row counts plus the message-text byte estimate (the
 * dominant share of a thread snapshot's wire size) — O(rows), no serialization.
 */
export const summarizeThreadForServeLog = (
  thread: OrchestrationThread,
): Record<string, unknown> => ({
  threadId: thread.id,
  messageRows: thread.messages.length,
  activityRows: thread.activities.length,
  approxTextBytes: thread.messages.reduce((total, message) => total + message.text.length, 0),
});

export const summarizeShellSnapshotForServeLog = (
  snapshot: OrchestrationShellSnapshot,
): Record<string, unknown> => ({
  projectRows: snapshot.projects.length,
  threadRows: snapshot.threads.length,
});

/**
 * Pipe-style wrapper: measure the effect; when it exceeds the threshold, log
 * one debug line merging the summarizer's fields (row counts, sizes, ids).
 * The summarizer runs only on slow serves, so it may be O(rows) but must never
 * re-serialize the payload.
 */
export const withSlowServeLog =
  <A>(endpoint: string, summarize: (value: A) => Record<string, unknown>) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const startedAtMillis = yield* Clock.currentTimeMillis;
      const value = yield* effect;
      const durationMs = (yield* Clock.currentTimeMillis) - startedAtMillis;
      if (durationMs > SLOW_SERVE_THRESHOLD_MILLIS) {
        yield* Effect.logDebug("[reconnect] slow snapshot serve", {
          endpoint,
          durationMs,
          ...summarize(value),
        });
      }
      return value;
    });
