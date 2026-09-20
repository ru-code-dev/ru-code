// ru-code v2: the loaded plugins, and nothing else.
//
// v1 had FIVE registries — panels, background views, composer items, composer providers, RPC — one
// per surface, each with its own store, its own caps and its own reset. Under the seam model there
// is nothing to register: the host holds the plugin OBJECT and asks it for a surface when it needs
// one (V2-2). So there is one list, written once per plugin at load, and every seam runner reads it.
//
// REACTIVE, because plugins load AFTER first paint (a plugin whose `activate()` never settles used
// to white-screen the app when the loader ran before `createRoot`). A panel or a page that lands a
// moment after boot must simply appear. `useSyncExternalStore` rather than zustand's own hook: it
// serves `getInitialState()` as the server snapshot, which would freeze every render outside the
// browser — and every SSR-shaped unit test — at the empty list.

import type { WebCtx, WebPlugin } from "@smart-tools/plugin-sdk/host";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** One plugin the web half loaded, with the ctx its seams are called with. */
export interface LoadedPlugin {
  readonly id: string;
  /** The manifest's display name — what a menu section and a fallback label read. */
  readonly name: string;
  /**
   * This plugin's index in `manifests.json` — its position in the SORTED plugins directory.
   *
   * Carried so the list below can be manifest-ordered rather than completion-ordered; see
   * {@link addLoadedPlugin}. The loader passes the same index to `recordPluginStatus`, so the
   * status table and the surface order agree by construction.
   */
  readonly order: number;
  readonly plugin: WebPlugin;
  readonly ctx: WebCtx;
}

interface RegistryState {
  /**
   * MANIFEST order — the order `manifests.json` lists, which is the sorted plugins directory,
   * which is stable across reloads. NOT the order the plugins finished loading in.
   */
  readonly plugins: ReadonlyArray<LoadedPlugin>;
  /**
   * How the loader's last pass ENDED (V2-27; S15 A1).
   *
   * `plugins` is empty twice over: before the loader has run, and when nothing is installed. Every
   * SURFACE can treat those the same — it draws nothing either way — but a consumer that deletes
   * state for a plugin that is not contributing cannot: plugins load AFTER first paint, so at boot
   * "nothing is contributed" is a lie for about a second.
   *
   * It cost exactly that (`pluginTabs.e2e.test.ts`, the per-thread case): a tab-mounted panel is a
   * PERSISTED surface of the app's right panel, and the reconcile that closes a tab whose panel is
   * gone ran on the empty pre-load list and closed the user's restored tab before its plugin had
   * loaded.
   *
   * S15 A1 — and a BOOLEAN "it finished" is still not enough, because the loader finishes three
   * ways and only one of them is evidence about plugins. `"unreadable"` is the pass that never got
   * a plugin list at all: no `manifests.json`, a server that did not answer, a payload that did not
   * decode. The registry is empty there for a reason that says NOTHING about what any plugin
   * contributes, so a consumer that deletes state must sit that pass out rather than read the empty
   * list as "everything is gone" — a dev server restarting under the open app would otherwise wipe
   * every persisted plugin tab. `"read"` is the only outcome that licenses a deletion.
   */
  readonly pass: PluginLoadPass;
}

/**
 * The outcome of the loader's last pass.
 *
 * · `"pending"` — the loader has not finished a pass yet (first paint).
 * · `"unreadable"` — it finished without ever reading a plugin list.
 * · `"read"` — it read `manifests.json` and every plugin in it has loaded, failed, timed out or
 *   been skipped. This is the only outcome under which "not in the registry" is a fact.
 */
export type PluginLoadPass = "pending" | "read" | "unreadable";

const useStore = create<RegistryState>(() => ({ plugins: [], pass: "pending" }));

/**
 * Add a loaded plugin, keeping the list in MANIFEST order.
 *
 * Called once per plugin by the loader, after its `activate` settled. The loader maps the manifests
 * CONCURRENTLY (one plugin's 10 s hang must not delay the next), so the call order here is
 * completion order and varies run to run with how long each plugin's `activate` takes. Appending
 * would make it the order of every surface downstream: composer sections, footer entries,
 * `[data-plugin-root]` in the DOM. S4-parity §2.2 measured exactly that — the `#` menu read
 * «DEMO → ВСТРОЕННЫЕ» in one run and «ГЛОБАЛЬНЫЕ → ВСТРОЕННЫЕ → DEMO» in another, off the same
 * install — while this file's own comment claimed manifest order. Sorting on `order` makes the
 * comment true.
 *
 * Sorted on WRITE (unlike `getPluginStatuses`, which sorts on read): every consumer here is a React
 * render reading `plugins` many times per load, and `useSyncExternalStore` compares the snapshot by
 * identity — a fresh sorted array per read would loop forever.
 *
 * Re-loading the same id REPLACES it rather than appending — the e2e suite reloads the page against
 * a changed folder, and two entries for one id would mount every surface twice.
 */
export function addLoadedPlugin(entry: LoadedPlugin): void {
  useStore.setState((state) => {
    const index = state.plugins.findIndex((loaded) => loaded.id === entry.id);
    const plugins = [...state.plugins];
    if (index < 0) plugins.push(entry);
    else plugins[index] = entry;
    // Stable, so two plugins sharing an `order` (only a hand-built test fixture can) keep
    // insertion order rather than swapping on every later add.
    plugins.sort((a, b) => a.order - b.order);
    return { plugins };
  });
}

/**
 * The store snapshot — what {@link usePlugins} serves on every render, in the browser and in an
 * SSR-shaped render alike.
 *
 * It is ONE named function rather than two inline closures because `useSyncExternalStore` compares
 * what it is given: a fresh closure per render is a fresh snapshot source per render. Reading it
 * directly is the imperative half of the same store, which is what the loader's own tests assert
 * against (S15 N6 — it stopped being a test-only reader when the hook started calling it).
 */
export function loadedPlugins(): ReadonlyArray<LoadedPlugin> {
  return useStore.getState().plugins;
}

/** Reactive read — re-renders when a plugin finishes loading. */
export function usePlugins(): ReadonlyArray<LoadedPlugin> {
  return useSyncExternalStore(useStore.subscribe, loadedPlugins, loadedPlugins);
}

/**
 * Announce how the loader's pass ended.
 *
 * Called by `loadPlugins` from a `finally`, so every exit — no `manifests.json`, an unreachable
 * server, a payload that does not decode, a throw, and the ordinary end — announces something,
 * rather than leaving consumers waiting forever. WHAT it announces is the point (S15 A1): the
 * early exits report `"unreadable"`, and only a pass that decoded a manifest list reports `"read"`.
 *
 * It records what it is told, every time, rather than latching on the first announcement (S15 N8 —
 * this used to claim it protected a long-lived tab from a server that went away, which no caller
 * can produce: `main.tsx` calls `loadPlugins()` once per page load and nothing re-runs it). What
 * the plain write does buy is that the rule stays one sentence — the outcome of the last pass is
 * what consumers see — so a future caller that DOES re-run the loader (a "rescan plugins" control,
 * an HMR hook) gets the conservative behaviour for free: a pass that reaches no server downgrades
 * to `"unreadable"` and every consumer that deletes state stops deleting.
 */
export function markPluginsPass(pass: Exclude<PluginLoadPass, "pending">): void {
  if (useStore.getState().pass !== pass) useStore.setState({ pass });
}

/** Reactive read — re-renders the moment the loader's pass is over. */
export function usePluginLoadPass(): PluginLoadPass {
  return useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().pass,
    () => useStore.getState().pass,
  );
}

/** Test seam — the registry is a module-level singleton by design. */
export function resetLoadedPlugins(): void {
  useStore.setState({ plugins: [], pass: "pending" });
}
