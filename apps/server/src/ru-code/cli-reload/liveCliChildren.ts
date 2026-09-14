// ru-code (cli-reload): THE registry of CLI children this server currently owns.
//
// ONE owner of "what is alive". Every qwen CLI child registers here at the moment it is
// spawned — the ACP session/warm-slot child in `QwenAcpSessionRuntime`, the one-shot `-p` child
// in `QwenTextGeneration` — and deregisters when its scope closes. The reload's kill pass ends
// with `killAllLiveCliChildren`, and "zero processes left" is read off this registry.
//
// WHY REGISTRATION LIVES AT THE SPAWN, not in the adapter's `sessions` map or the pid journal:
//   · `sessions` is populated only AFTER the whole ACP handshake (`QwenAdapter` `sessions.set`),
//     so a start parked in `authenticate` — the exact state that makes a user press Reload CLI —
//     is invisible to `stopAll` (adversary A-2). The registry sees it because it registers at
//     the spawn, before the handshake.
//   · `QwenProcessJournal` records at the same two ACP sites but is gated on the warm engine
//     (`QwenAdapter`: `const processJournal = warmEngine ? … : undefined`), so with
//     `RU_CODE_WARM_ENGINE=0` — the configuration the browser e2e runs — it knows nothing. It
//     also holds no kill handle: it is a write-only pid FILE for a future crash-reaper, and it
//     stays exactly that. The registry is the in-memory liveness owner; there is no second
//     liveness list anywhere (D3's separate text-generation tracking was folded in here).
//
// The registry is process-wide, like the reload latch and the auth flag: "which CLI children
// does this SERVER own" is a server-wide question, and the reload answers it for every
// configured qwen instance at once.

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeChangeSignal } from "./changeSignal.ts";

/** What a child is, for diagnostics and for the reload's own logging. */
export type LiveCliChildKind = "acp" | "textgen";

export interface LiveCliChild {
  readonly pid: number;
  readonly kind: LiveCliChildKind;
  /** SIGKILL the child's process GROUP and await its exit (the spawner's `kill` does both). */
  readonly forceKill: Effect.Effect<void>;
  readonly waitForExit: Effect.Effect<void>;
}

const live = new Set<LiveCliChild>();
/**
 * Announced on EVERY mutation of `live`. The reload's fixpoint waits on this instead of
 * re-testing in a spin (adversary R3-1).
 */
const changed = makeChangeSignal();

/**
 * The handle the next registry mutation will complete. Take it BEFORE reading the registry.
 */
export const nextLiveCliChildrenChange: Effect.Effect<Deferred.Deferred<void>> = changed.next;

/**
 * Register for the lifetime of the calling scope — the scope that owns the child, so the entry
 * disappears exactly when the child does.
 */
export const registerLiveCliChild = (child: LiveCliChild) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      live.add(child);
      changed.signalUnsafe();
    }),
    () =>
      Effect.sync(() => {
        if (live.delete(child)) changed.signalUnsafe();
      }),
  );

/** Everything still alive. THE zero-oracle: empty ⇒ this server owns no CLI process. */
export const listLiveCliChildren: Effect.Effect<ReadonlyArray<LiveCliChild>> = Effect.sync(() =>
  Array.from(live),
);

/**
 * The same read, synchronously — for callers that CANNOT suspend (a poll predicate in a spec).
 * Naming follows the effect convention for a non-Effect escape hatch.
 */
export const listLiveCliChildrenUnsafe = (): ReadonlyArray<LiveCliChild> => Array.from(live);

/**
 * SIGKILL every registered child and await its exit. Uninterruptible: a half-run kill pass is
 * the one outcome the reload must never produce (the same position `stopAllWarm` takes).
 */
export const killAllLiveCliChildren: Effect.Effect<void> = Effect.uninterruptible(
  Effect.suspend(() => {
    const children = Array.from(live);
    if (children.length === 0) return Effect.void;
    return Effect.logDebug("[cli-reload] killing live CLI children", {
      count: children.length,
      kinds: children.map((child) => child.kind),
    }).pipe(
      Effect.andThen(
        Effect.forEach(
          children,
          (child) =>
            // Kill, await the exit, and DROP THE ENTRY here rather than waiting for the owning
            // scope to unwind. The scope close is asynchronous (a session start only unwinds
            // once its failed handshake propagates), so leaving removal to it would make the
            // zero-oracle read "still alive" for a child that is provably dead. The scoped
            // release stays as the normal path and is a no-op for an entry already dropped.
            Effect.andThen(child.forceKill, child.waitForExit).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (live.delete(child)) changed.signalUnsafe();
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
  }),
);

/** Tests only — the singleton above has no production reset. */
export const resetLiveCliChildrenForTests = (): void => {
  live.clear();
  changed.resetUnsafe();
};
