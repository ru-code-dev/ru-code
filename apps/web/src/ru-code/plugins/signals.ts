// ru-code v2: the values a plugin may WATCH, as plain `Signal<T>` (architecture.md §2.1, V2-15).
//
// WHY SIGNALS AND NOT HOOKS. v1 handed plugins the app's own React hooks on `host.hooks.*` — five
// of them, three reaching into app stores and route state. That is the boundary rule broken twice
// over: the plugin gets host code, and the host can no longer change how it computes a value
// without changing plugin ABI. A `Signal<T>` is `{ get, subscribe }` and nothing else: readable
// from `activate` and from a background loop, and turned into a re-render by the SDK's own
// `useSignal` (which runs on the SHARED React, so it is the plugin's hook, not the host's).
//
// WHERE THE VALUES COME FROM. The app's answers live behind app hooks, so the flow is inverted:
// `PluginSignalBridge` (mounted inside `PluginBackground`, above the router) READS the app hooks
// and pushes into these signals. Nothing app-shaped is ever handed across the boundary, and a
// plugin that reads `ctx.theme.get()` outside React gets the value the app committed last.

import type {
  PluginConnection,
  PluginLocale,
  PluginProject,
  PluginTheme,
  Signal,
} from "@smart-tools/plugin-sdk/host";

/** A `Signal<T>` the host writes and plugins read. `set` notifies synchronously. */
export type MutableSignal<T> = Signal<T> & {
  set(next: T): void;
  /** Diagnostics + tests: how many plugin components are watching. */
  readonly listenerCount: number;
};

/** The read-only face handed to plugins: `get` + `subscribe` only — a plugin can never `set` a host signal. */
export const readonlySignal = <T>(signal: MutableSignal<T>): Signal<T> => ({
  get: signal.get,
  subscribe: signal.subscribe,
});

export const makeSignal = <T>(initial: T): MutableSignal<T> => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    // Bound methods, not prototype lookups: a plugin passes `signal.get` straight into
    // `useSyncExternalStore`, which calls it unbound.
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      // A COPY of the set, deliberately: a listener that unsubscribes itself while we notify
      // must not shorten the iteration out from under the ones after it.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
};

/**
 * The locale is fixed for the lifetime of the document — changing the language writes the server
 * setting and RELOADS the page, which is the only way module-level `L()` constants are
 * re-evaluated. It is a signal anyway so a plugin writes one shape for all three.
 */
export const localeSignal: MutableSignal<PluginLocale> = makeSignal<PluginLocale>("en");

export const themeSignal: MutableSignal<PluginTheme> = makeSignal<PluginTheme>("light");

/**
 * The project of the thread (or draft) the user is looking at — V2-15, closing catalogs R2.
 *
 * `null` is a REAL answer and not "unknown": on a surface with no thread there is no project scope,
 * which the catalog packages already define as "globals only". v1 handed plugins the app's own
 * `useActiveProjectId()` hook; the bridge reads the same hook and pushes the value here instead, so
 * the app keeps the freedom to change how it computes it.
 */
export const activeProjectSignal: MutableSignal<string | null> = makeSignal<string | null>(null);

/** The empty list, as one identity: `Object.is` in `set` then makes a re-push a no-op. */
const NO_PROJECTS: ReadonlyArray<PluginProject> = [];

/**
 * Every project the app knows about — V2-15, closing catalogs R4.
 *
 * The catalogs port had to re-read its own project list on the connection's ready-flip and on every
 * panel mount, because nothing told it the SET had changed; a project added mid-session with no
 * panel open went unnoticed until the next one.
 */
export const projectsSignal: MutableSignal<ReadonlyArray<PluginProject>> =
  makeSignal<ReadonlyArray<PluginProject>>(NO_PROJECTS);

/**
 * The provider instance the composer would send to on the current thread — V2-15.
 *
 * `null` off a thread. The app's own resolution has two more steps this deliberately does NOT
 * repeat (`deriveLockedProvider`, and `resolveSelectableProvider`'s fallback to the first ENABLED
 * provider, both of which need the environment's server config): what a plugin gates rows on is
 * which provider the thread is FOR, and that is the draft's `activeProvider` or the thread's own
 * model selection. Anything finer would be the app's policy leaking across the boundary.
 */
export const providerSignal: MutableSignal<string | null> = makeSignal<string | null>(null);

/**
 * ru-code: plugins — the composer the user is on RIGHT NOW, as an opaque token (V2-48).
 *
 * Written by `PluginSignalBridge` from the app's own route-following resolution
 * (`ru-code/composer/activeComposerTarget.ts`), the SAME answer the app's own surfaces use, so a
 * plugin's tray and the app's composer can never disagree about which draft is in front of the
 * user. `null` off a thread or draft, which is a REAL answer meaning "no composer here".
 */
export const composerTargetSignal: MutableSignal<string | null> = makeSignal<string | null>(null);

/** Test seam — the signals are module singletons, exactly like the app state behind them. */
export const resetPluginSignals = (): void => {
  composerTargetSignal.set(null);
  localeSignal.set("en");
  themeSignal.set("light");
  activeProjectSignal.set(null);
  projectsSignal.set(NO_PROJECTS);
  providerSignal.set(null);
};

/**
 * Replace the project list only when it really CHANGED.
 *
 * The bridge recomputes on every app render that touches the project store, and `set` compares by
 * `Object.is` — a fresh array of identical rows would notify every plugin component on every one of
 * those renders. Field-by-field, because the rows are rebuilt from the app's own model each time.
 */
export const setPluginProjects = (next: ReadonlyArray<PluginProject>): void => {
  const current = projectsSignal.get();
  const same =
    current.length === next.length &&
    current.every((project, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        candidate.id === project.id &&
        candidate.name === project.name &&
        candidate.cwd === project.cwd
      );
    });
  if (!same) projectsSignal.set(next);
};

/**
 * The app's own three-state connection projection, narrowed to the SDK's vocabulary — the one
 * mapping `connectionAtom.ts` derives `ctx.connection` through (S28 V2-35, S33 A9).
 *
 * v1 typed this `string` "for forward compatibility" and both shipped plugins had to discover the
 * usable value empirically — one of them shipped a permanently-false gate because the brief said
 * `"connected"`. A closed union with a documented mapping costs nothing and cannot be guessed
 * wrong.
 */
export const toPluginConnection = (phase: string | null): PluginConnection => {
  if (phase === "ready") return "ready";
  if (phase === "disconnected") return "lost";
  return "connecting";
};
