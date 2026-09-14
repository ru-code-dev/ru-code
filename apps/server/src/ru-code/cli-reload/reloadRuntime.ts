// ru-code (cli-reload): the server-wide, in-memory coordination state the reload needs.
//
// Three things live here, all process-scoped singletons (precedent for a module-level runtime
// cache: ru-code/qwen/versionProbeCache.ts — "the process cache has no production reset"):
//
//   1. THE RELOAD LATCH (D1/R2). One reload at a time. A second request while one is running
//      does not start a second pass: it awaits the running one and returns ITS result. Every
//      CLI spawn path awaits the latch too, so a send arriving mid-reload gets a fresh
//      session AFTER the kill — closing the refill race (research C-G1) without touching the
//      warm-pool package (research S-1: it is a `file:` dep served from dist).
//   2. THE IDLE-RESET OBSERVATION (D4). The warm pool exposes no event and a second clock is
//      forbidden, so the ACTIVE→EXPIRED edge is read on the path that is about to spawn.
//      (The auth flag and the spawn permit themselves live in cliSpawnScheduler.ts — that
//      module owns the whole "may this CLI spawn now, and who goes first" decision.)
//   3. THE QWEN INSTANCE REGISTRY. Every qwen adapter registers its `stopAll`, its resolved
//      profile dir and a reader for its warm-pool state. The alternative — `getAdapterEntries`
//      in ProviderService — is a closure local (ProviderService.ts:374) that neither the
//      service object (:1268-1287) nor `ProviderServiceShape` exposes, so reaching it means
//      editing two upstream files, and it still would not carry the per-instance profile dir
//      the delete step needs (research D-G1). Registering from our own adapter is tier-1
//      delegation (fork rule R5) and is qwen-only by construction (owner ruling R1).
//
// No timers. The only clock in this feature is the warm pool's own idle sweeper
// (RESET_ACP_SESSIONS_AFTER_HOURS, owner ruling R9); `observeIdleExpiry` below reads the
// state that sweeper maintains, it never schedules anything.

import { CliReloadError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

/** What the warm pool reports. `null` from a reader ⇒ the warm engine is off for that instance. */
export interface QwenPoolSnapshot {
  /** EXPIRED (boot / after an idle reset) or ACTIVE (a chat used the pool). */
  readonly state: "expired" | "active";
  /** Live chain-link fibers pool-wide — the observable for "nothing is armed behind us". */
  readonly pendingRefills: number;
  /** Parked spares pool-wide. */
  readonly total: number;
}

/** One live qwen adapter instance, as the reload engine sees it. */
export interface QwenReloadInstance {
  readonly instanceId: string;
  /** `adapter.stopAll()` — kills idle sessions + warm spares, settles active turns, drains. */
  readonly stopAll: Effect.Effect<void>;
  /**
   * The dir the CLI actually runs from for THIS instance (`profileResolver` → `resolved.dir`,
   * `~` already expanded), or `""` when the CLI is left on its own default (owner ruling R3).
   */
  readonly profileDir: string;
  /**
   * Live read of this instance's warm pool (`null` ⇒ warm engine off). This is also the only
   * read-only window onto `pendingRefills` — the pool handle is a closure local in the
   * adapter (QwenAdapter.ts:977) and `QwenAdapterShape` exposes nothing (research F-G3).
   */
  readonly readPool: Effect.Effect<QwenPoolSnapshot | null>;
  /**
   * What an IDLE RESET of this instance's pool must do — built by the adapter because it is
   * the one place that already carries FileSystem/Path, so nothing leaks those requirements
   * into the spawn sites (D4).
   */
  readonly onIdleExpiry: Effect.Effect<void>;
}

const instances = new Map<string, QwenReloadInstance>();
/** Last pool state observed per instance — the ACTIVE→EXPIRED edge IS the idle reset. */
const lastPoolState = new Map<string, "expired" | "active" | "none">();

let reloading: Deferred.Deferred<void, CliReloadError> | null = null;

// ── instance registry ────────────────────────────────────────────────────────────────────

/** Register for the lifetime of the calling scope (the adapter's layer scope). */
export const registerQwenInstance = (instance: QwenReloadInstance) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      instances.set(instance.instanceId, instance);
    }),
    () =>
      Effect.sync(() => {
        instances.delete(instance.instanceId);
        lastPoolState.delete(instance.instanceId);
      }),
  );

export const listQwenInstances: Effect.Effect<ReadonlyArray<QwenReloadInstance>> = Effect.sync(() =>
  Array.from(instances.values()),
);

/**
 * The reload emptied every pool. Records that as the last-seen state so the ACTIVE→EXPIRED
 * transition the drain produced is consumed HERE and never re-read as an idle reset by a
 * spawn path that samples after the reload's latch is released.
 */
export const notePoolsDrained: Effect.Effect<void> = Effect.sync(() => {
  for (const instanceId of instances.keys()) lastPoolState.set(instanceId, "expired");
});

// ── idle-reset observation (D4) ──────────────────────────────────────────────────────────

/**
 * Apply the idle-reset consequences for every instance whose pool has crossed ACTIVE →
 * EXPIRED since we last looked. The pool exposes no event and editing it is a rebuild+relink
 * (research S-1), and a second timer is forbidden (owner ruling R9) — so this is the same
 * shape as the pool's OWN lazy half ("a machine that slept past the window resets BEFORE
 * serving a stale spare", WarmAcpPool.ts:768-774), lifted one level up: the edge is read on
 * the path that is about to spawn, so the consequences always land BEFORE the next CLI child
 * exists, which is the property D4 is for.
 *
 * NOT called from the pool's own slot spawn (`fromPool`): `readPool` takes the pool
 * mutex and the pool holds that mutex across `makeRuntime`. It does not need to be: after an
 * idle reset the pool is EXPIRED with the eager chain un-started and `PREWARM_ON_EXPIRED = 0`
 * (constants.ts:155), so `startEagerLocked` returns immediately and the next slot spawn can
 * only be armed by `ensureAfterSuccess`, which follows a `take` — and a `take` is preceded by
 * this observation in the adapter.
 */
export const observeIdleExpiry: Effect.Effect<void> = Effect.suspend(() =>
  Effect.forEach(
    Array.from(instances.values()),
    (instance) =>
      Effect.gen(function* () {
        const snapshot = yield* instance.readPool;
        const state = snapshot === null ? "none" : snapshot.state;
        const previous = lastPoolState.get(instance.instanceId);
        lastPoolState.set(instance.instanceId, state);
        if (previous !== "active" || state !== "expired") return;
        // A pool that emptied while a RELOAD was running did not go idle — the reload drained
        // it. Recording the new state (above) and firing nothing is what keeps "idle reset"
        // meaning idle reset: a reload has already cleared the flag and run its own delete,
        // and reporting its drain as an expiry would log a reset that never happened.
        if (reloading !== null) return;
        yield* Effect.logDebug("[cli-reload] warm pool idle reset observed", {
          instanceId: instance.instanceId,
        });
        yield* instance.onIdleExpiry;
      }),
    { concurrency: 1, discard: true },
  ),
);

// ── the reload latch (D1 / owner ruling R2) ──────────────────────────────────────────────

/**
 * Run `body` as THE reload. A second request while one is running returns the running one's
 * result instead of starting a second pass (owner ruling R2).
 *
 * The reload is a SERVER-OWNED operation, not a request-owned one: the body is FORKED into
 * `scope` — the reload service's own, which lives exactly as long as the server runtime — and
 * the caller only awaits the latch. A WS disconnect or a browser page reload therefore cannot
 * interrupt a reload in flight (owner ruling R8); it only stops someone waiting for the answer.
 * The latch is completed on every exit of the body, so waiters always learn the outcome —
 * including when server shutdown closes that scope and interrupts the reload, which is the one
 * case the kill+sweep uninterruptible unit in the engine exists for.
 */
export const runExclusiveReload = (scope: Scope.Scope, body: Effect.Effect<void, CliReloadError>) =>
  Effect.suspend(() => {
    const running = reloading;
    if (running !== null) return Deferred.await(running);
    const latch = Deferred.makeUnsafe<void, CliReloadError>();
    reloading = latch;
    return body.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          reloading = null;
        }).pipe(Effect.andThen(Deferred.done(latch, exit))),
      ),
      Effect.forkIn(scope),
      Effect.andThen(Deferred.await(latch)),
    );
  });

// ── tests ────────────────────────────────────────────────────────────────────────────────

/**
 * Tests only — the process singletons above have no production reset (same contract as
 * `clearVersionProbeCacheForTests`, versionProbeCache.ts:38-40). Vitest runs many adapters in
 * one process; without this, one spec's registry decides the next spec's reload. The scheduler has its own
 * `resetCliSpawnSchedulerForTests`.
 */
export const resetCliReloadRuntimeForTests = (): void => {
  instances.clear();
  lastPoolState.clear();
  reloading = null;
};
