// ru-code (A22, SDK 0.3.0, owner decision O3-b): `host.registerBackgroundView(render)` — the
// always-mounted, render-nothing plugin surface.
//
// WHY IT EXISTS. Two of the app's own drivers are exactly this shape and neither was reachable
// from a plugin: `CatalogAutoResync` (mounted in `AppSidebarLayout`, reconciles the catalogs when
// the connection comes up or the project set changes) and `AutoUpdateDriverMount` (mounted in
// `routes/__root.tsx`, keeps a poll alive across navigation). `registerPanel` renders only while
// the panel is OPEN, and `activate()` runs once with no way to observe React state — so a plugin
// that had to keep a store primed or react to app state had nowhere to put the component that
// does it. This is that place, and it is the same mechanism the composer PROVIDER drivers use
// (`composerProviders.ts`), which is the whole reason (b) beat (a) and (c) in O3: one machinery,
// not two.
//
// THE STORE IS A LIST, NOT A MAP. Registration order is mount order, and it is stable across
// renders because it is the order `activate()` ran in. A `Map` would tie the mount order of app
// chrome to a hash-table's iteration order.
//
// CAP: 2 per plugin. A background view runs on every render of a surface the whole app depends on,
// so this is deliberately the tightest cap in the host — a plugin with three of these has written
// one component that should have been three hooks.

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** ru-code (A22): at most this many background views per plugin. See the module header. */
export const MAX_BACKGROUND_VIEWS_PER_PLUGIN = 2;

export interface PluginBackgroundViewEntry {
  /** `background:<pluginId>:<n>` — stable across re-renders, unique across plugins. */
  readonly key: string;
  readonly pluginId: string;
  /** Already wrapped in the plugin's boundary + Suspense by `renderSafety.tsx`. */
  readonly render: () => ReactNode;
}

interface PluginBackgroundViewsState {
  readonly views: ReadonlyArray<PluginBackgroundViewEntry>;
  /** Bumped on every registration — what `usePluginBackgroundViews` re-renders on. */
  readonly revision: number;
}

const useStore = create<PluginBackgroundViewsState>(() => ({ views: [], revision: 0 }));

/**
 * Append one background view. The caller (`hostApi.ts`) has already applied the per-plugin cap and
 * wrapped `render` in the plugin's boundary, so this is a pure store write.
 */
export function addPluginBackgroundView(entry: PluginBackgroundViewEntry): void {
  useStore.setState((state) => ({
    views: [...state.views, entry],
    revision: state.revision + 1,
  }));
}

/** How many views this plugin already holds — the input to the cap. */
export function pluginBackgroundViewCount(pluginId: string): number {
  return useStore.getState().views.filter((view) => view.pluginId === pluginId).length;
}

/** Test seam. */
export function resetPluginBackgroundViews(): void {
  useStore.setState({ views: [], revision: 0 });
}

/** Every registered view, in registration order (diagnostics + tests). */
export function allPluginBackgroundViews(): ReadonlyArray<PluginBackgroundViewEntry> {
  return useStore.getState().views;
}

/**
 * The views to mount, re-rendering when a plugin registers one.
 *
 * `useSyncExternalStore` rather than zustand's own hook, for the same reason the panel and
 * composer registries use it: zustand serves `getInitialState()` as the server snapshot, which
 * would freeze the list at empty outside the browser.
 */
export function usePluginBackgroundViews(): ReadonlyArray<PluginBackgroundViewEntry> {
  return useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().views,
    () => useStore.getState().views,
  );
}
