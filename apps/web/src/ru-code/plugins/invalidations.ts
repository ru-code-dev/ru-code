// ru-code v2 (V2-25): the CONTRIBUTION-CHANGED signal — one version per plugin per seam.
//
// WHAT WAS MISSING. A seam is a plain call (`plugins.map(p => p.seam?.(ctx))`) and the host makes it
// when the HOST needs the surface: a menu opened, a panel mounted, a plugin finished loading. The
// runners in `seams.tsx` therefore key on `(plugins, trigger, query)` — every input the HOST owns —
// and none of those move when the store a plugin answers FROM moves. An answer taken before the
// plugin's first fetch landed stayed the answer for the life of the mount.
//
// That cost the app a real defect (S11): `useQwenPluginCommandSlugs` asks `composer.items("/", "")`
// once per `ChatView` mount to learn which `/commands` may be sent, the catalogs plugin answered it
// while its transport was still coming up (`primeCatalogOnce` returns early unless
// `ctx.connection === "ready"`), and every one of the user's own commands was then refused at submit
// until the view remounted.
//
// THE FIX IS GENERIC, not a catalogs patch (rules §26: whatever a plugin contributes and the host
// consumes must have a change signal). `ctx.invalidate(seam)` bumps a counter, the runners put the
// counter in their inputs, and the seam is re-asked — for any plugin, for all four seams.
//
// PER PLUGIN, AND THE RUNNERS KEY ON THE PLUGIN'S OWN NUMBER (V2-40).
//
// Until S38 this file kept the per-plugin versions AND a cross-plugin SUM per seam, and the runners
// read the SUM — so ONE plugin's invalidation re-asked EVERY plugin's seam, while the SDK promised
// the opposite in as many words ("the host recomputes that seam for YOUR plugin only",
// `plugin-sdk/src/host/index.ts:156`). It was not free: the catalogs plugin invalidates `composer`
// after every resync and every panel mutation, and the demo plugin's `/` row is built with a
// `ctx.invoke("context.build")` — TEN wire frames from a plugin whose data had not moved, measured
// on a single reload (`WORKFLOW/logs/S38/1-e2e-boot-red.log`).
//
// So a seam's state is now ONE MAP PER SEAM, `pluginId → version`, replaced as a whole when a
// plugin in it bumps. That single object is both halves of what a runner needs:
//
//  · its IDENTITY changes exactly when this seam moved for somebody — the `useSyncExternalStore`
//    snapshot, so the runner re-renders (and no other seam's runner does);
//  · its ENTRIES say WHICH plugin moved — the key each runner memoizes that plugin's contribution
//    under (`seams.tsx` `useSeamContributions`), so the others are not called again.
//
// There is deliberately no total any more: a number that is the sum of every plugin's changes is a
// number no consumer can act on without re-asking everyone, which is the defect above.

import type { InvalidateSeam } from "@smart-tools/plugin-sdk/host";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { INVALIDATE_SEAMS } from "./caps";

/** Every loaded plugin's version for ONE seam. Absent ⇒ that plugin has never invalidated it. */
export type SeamVersions = Readonly<Record<string, number>>;

const NO_VERSIONS: SeamVersions = Object.freeze({});

type VersionsBySeam = Readonly<Record<InvalidateSeam, SeamVersions>>;

const ZERO: VersionsBySeam = Object.freeze(
  Object.fromEntries(INVALIDATE_SEAMS.map((seam) => [seam, NO_VERSIONS])) as Record<
    InvalidateSeam,
    SeamVersions
  >,
);

interface InvalidationState {
  /** How many times each plugin has invalidated each seam (V2-25's "version per plugin per seam"). */
  readonly bySeam: VersionsBySeam;
}

const useStore = create<InvalidationState>(() => ({ bySeam: ZERO }));

/**
 * One plugin says its contribution to one seam changed.
 *
 * Called by `ctx.invalidate` and by nothing else; the seam name is validated there, so a bad one
 * never reaches this map and the key set stays bounded by (loaded plugins × 4). Only the named
 * seam's map is replaced, so a `composer` bump leaves the `panels` runner's snapshot untouched and
 * it does not even re-render.
 */
export function invalidatePluginSeam(pluginId: string, seam: InvalidateSeam): void {
  useStore.setState((state) => {
    const versions = state.bySeam[seam];
    return {
      bySeam: {
        ...state.bySeam,
        [seam]: { ...versions, [pluginId]: (versions[pluginId] ?? 0) + 1 },
      },
    };
  });
}

/** How many times THIS plugin has invalidated THIS seam — the number a runner memoizes on. */
export function pluginSeamVersion(pluginId: string, seam: InvalidateSeam): number {
  return useStore.getState().bySeam[seam][pluginId] ?? 0;
}

/** Every plugin's version for one seam, as the one object a runner reads. */
export function seamVersions(seam: InvalidateSeam): SeamVersions {
  return useStore.getState().bySeam[seam];
}

/**
 * Reactive {@link seamVersions} — the two lines that make a runner recompute.
 *
 * `useSyncExternalStore` rather than zustand's own hook, for the reason `registry.ts` states: the
 * zustand hook serves `getInitialState()` as the server snapshot, which would freeze every render
 * outside the browser at the empty map. The snapshot is the seam's own map, whose identity is
 * stable until a plugin invalidates THIS seam — so it is safe as a `useMemo`/effect dependency.
 */
export function useSeamVersions(seam: InvalidateSeam): SeamVersions {
  return useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().bySeam[seam],
    () => useStore.getState().bySeam[seam],
  );
}

/** Test seam — the counters are a module-level singleton, like the registry they travel with. */
export function resetPluginInvalidations(): void {
  useStore.setState({ bySeam: ZERO });
}
