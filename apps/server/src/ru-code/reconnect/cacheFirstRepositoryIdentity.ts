/**
 * ru-code (boot performance, Fix G): repository identity OFF the snapshot
 * critical path. The underlying `RepositoryIdentityResolver` runs an UNCACHED
 * stage-1 `git rev-parse --show-toplevel` per resolve with the 60 s
 * ProcessRunner default timeout — one hung git (dead mount, index.lock, AV
 * scan, cold fsmonitor) holds every shell/full snapshot hostage for the whole
 * timeout, per serve, per reconnect (pin L5: thread list at 67.5 s).
 *
 * This wrapper makes the snapshot path cache-first: `resolve` answers from its
 * own cache (or `null` when unknown) IMMEDIATELY and never runs git inline.
 * Unknown/expired roots fork ONE deduped background fill onto the layer scope,
 * which runs the real resolver with its normal generous timeout and stores the
 * result under a positive/negative TTL. The badge then appears on the next
 * snapshot delivery (reconnect / refresh) — an expired entry keeps serving its
 * stale value while the refresh runs, so a known badge never flickers off.
 *
 * Plain delegation, NO DI change: `ProjectionSnapshotQuery`'s Live constructs
 * it around the ambient resolver; tests keep providing a plain `resolve` mock.
 *
 * @module ru-code/reconnect/cacheFirstRepositoryIdentity
 */
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface CacheFirstRepositoryIdentityOptions {
  /** How long a resolved identity is served before a background refresh. */
  readonly positiveTtl?: Duration.Input;
  /** How long a `null` (no repo / no remote / git timed out) is served. */
  readonly negativeTtl?: Duration.Input;
}

// Mirror the underlying resolver's own stage-2 cache defaults (1 minute both):
// the wrapper changes WHERE the wait happens (background, never inline), not
// how fresh the identity is.
const DEFAULT_POSITIVE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_TTL = Duration.minutes(1);

interface CacheFirstEntry {
  readonly value: RepositoryIdentity | null;
  readonly expiresAtMillis: number;
}

/**
 * Build the cache-first `resolve` around an already-resolved resolver service.
 * Runs in a scoped context (the owning layer's build): background fills are
 * forked onto that scope, so layer teardown interrupts any in-flight git.
 */
export const makeCacheFirstRepositoryIdentity = Effect.fnUntraced(function* (
  resolver: {
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  },
  options?: CacheFirstRepositoryIdentityOptions,
) {
  const forkScope = yield* Effect.scope;
  const positiveTtlMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options?.positiveTtl ?? DEFAULT_POSITIVE_TTL),
  );
  const negativeTtlMillis = Duration.toMillis(
    Duration.fromInputUnsafe(options?.negativeTtl ?? DEFAULT_NEGATIVE_TTL),
  );

  const cache = new Map<string, CacheFirstEntry>();
  const inFlight = new Set<string>();

  const startBackgroundFill = (cwd: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (inFlight.has(cwd)) {
        return;
      }
      inFlight.add(cwd);
      yield* resolver.resolve(cwd).pipe(
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((completedAtMillis) => {
              cache.set(cwd, {
                value,
                expiresAtMillis:
                  completedAtMillis + (value === null ? negativeTtlMillis : positiveTtlMillis),
              });
            }),
          ),
        ),
        // The resolver's contract is failure-free (timeouts resolve to null);
        // this guards defects so a broken fill can never take the fiber down
        // silently — and leaves the field-diagnosable trace.
        Effect.catchCause((cause) =>
          Effect.logDebug("[repo-identity] background resolve failed", { cwd, cause }),
        ),
        Effect.ensuring(Effect.sync(() => inFlight.delete(cwd))),
        Effect.forkIn(forkScope),
      );
    });

  const resolve = (cwd: string): Effect.Effect<RepositoryIdentity | null> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const entry = cache.get(cwd);
      if (entry !== undefined && entry.expiresAtMillis > nowMillis) {
        return entry.value;
      }
      yield* startBackgroundFill(cwd);
      return entry !== undefined ? entry.value : null;
    });

  return { resolve };
});
