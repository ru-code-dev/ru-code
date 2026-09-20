// ru-code: what happened to each plugin in THIS page load (mvp-plan §1.4 `status.ts`).
//
// TWO halves with two different jobs, and only the second one is reactive (S15 B1 — the note above
// `recordPluginDisplayName` below carries the argument). The STATUS list is deliberately a plain
// module-level array, not a store: nothing React renders reads it. The
// REGISTRIES a plugin writes into are reactive (A4 H2/M2 — plugins load after first paint),
// but this list is a diagnostic: it exists so a human — or a later Plugins settings page
// (mvp-plan §5) — can ask why a panel is missing, and so `flushPluginProblems()` has
// something to turn into a toast. Each status is recorded the moment ITS OWN plugin settles
// (A7 finding L2) — waiting for `Promise.all` hid the healthy plugins' diagnostics for the
// whole of a hanging plugin's 10 s budget, i.e. during exactly the window someone is looking
// for the explanation. Manifest order is kept by recording the manifest INDEX beside each
// status and sorting on read, so concurrent loading still does not shuffle the list.

import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** Mirrors the SDK's `PluginState`, narrowed to what the web loader can actually produce. */
export type WebPluginLoadState = "loaded" | "failed" | "skipped";

export interface WebPluginStatus {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: WebPluginLoadState;
  /** Present only for `failed` / `skipped`; already stringified (never an Error instance). */
  readonly error?: string;
}

interface RecordedStatus {
  /** The plugin's position in the manifest list; ties keep insertion order. */
  readonly order: number;
  readonly status: WebPluginStatus;
}

const statuses: RecordedStatus[] = [];

/**
 * Record one plugin's outcome, as soon as that plugin settles.
 *
 * `order` is the plugin's index in the manifest list. It defaults to "append", so a caller
 * that has no list to order against (a single status, a test) still reads back in call order.
 */
export function recordPluginStatus(status: WebPluginStatus, order = statuses.length): void {
  statuses.push({ order, status });
}

/** Every plugin the loader considered, in manifest order. */
export function getPluginStatuses(): readonly WebPluginStatus[] {
  // Sorted on read, not on write: the list is one entry per installed plugin, and sorting
  // here keeps `recordPluginStatus` a plain append that cannot reorder what is already read.
  // `Array.prototype.sort` is stable, so two statuses with the same index keep insertion order.
  return [...statuses].sort((a, b) => a.order - b.order).map((entry) => entry.status);
}

/** Test seam — the loader is a module-level singleton by design. */
export function resetPluginStatuses(): void {
  statuses.length = 0;
}

// ru-code: a plugin's DISPLAY name, by id.
//
// The composer registry labels a plugin's menu section with the name a human reads, but the
// composer port (like every per-plugin seam) is keyed by id alone. The loader knows both, so it
// records the pairing here and everything downstream looks it up.
//
// REACTIVE, unlike the status list above, and S15 B1 is the reason. The name is recorded for EVERY
// manifest row — including a plugin that then fails to load — and since V2-27 there is a surface
// that outlives its plugin: a persisted tab whose panel is gone keeps its place and is labelled
// with this name. Nothing else about that tab changes when the loader finally records the name, so
// a plain `Map` read during render showed the plugin's ID until some unrelated repaint came along.
// Rules §26: what the host renders from a plugin needs a change signal, not luck.
//
// The other three readers (`ComposerCommandMenu`, `PluginSurface`, `rootErrors`) are fine with the
// imperative {@link pluginDisplayName}: each of them only ever draws for a plugin that HAS loaded,
// which is strictly after its name was recorded.

interface DisplayNameState {
  /** Replaced, never mutated: the identity IS the change signal `useSyncExternalStore` compares. */
  readonly names: ReadonlyMap<string, string>;
}

const useNameStore = create<DisplayNameState>(() => ({ names: new Map() }));

export function recordPluginDisplayName(id: string, name: string): void {
  const names = useNameStore.getState().names;
  // The loader records every manifest row on every pass; re-recording the same pairing must not
  // hand subscribers a new snapshot, or every reload would repaint the whole tab strip.
  if (names.get(id) === name) return;
  const next = new Map(names);
  next.set(id, name);
  useNameStore.setState({ names: next });
}

/** The snapshot {@link usePluginDisplayNames} serves — and the imperative read beside it. */
export function pluginDisplayNames(): ReadonlyMap<string, string> {
  return useNameStore.getState().names;
}

/** The change signal: it fires when a name lands, and not when one is re-recorded unchanged. */
export function subscribePluginDisplayNames(listener: () => void): () => void {
  return useNameStore.subscribe(listener);
}

/**
 * Resolve one name out of a snapshot: the manifest name, falling back to the id (never empty,
 * never a throw). Pure, so the rule is checkable without a store — and so a component that already
 * holds the snapshot resolves without reading the store again.
 */
export function displayNameOf(names: ReadonlyMap<string, string>, id: string): string {
  const name = names.get(id);
  return name === undefined || name.trim() === "" ? id : name;
}

/** The plugin's manifest name, falling back to its id. Non-reactive — see the note above. */
export function pluginDisplayName(id: string): string {
  return displayNameOf(pluginDisplayNames(), id);
}

/**
 * Reactive read, for the one surface that can outlive its plugin (the right panel's tab strip).
 *
 * `useSyncExternalStore` rather than zustand's own hook, for the reason `registry.ts` states: the
 * server snapshot is the live map, so a render outside the browser — every SSR-shaped unit test in
 * this project — sees what was recorded rather than a frozen empty one.
 */
export function usePluginDisplayNames(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribePluginDisplayNames, pluginDisplayNames, pluginDisplayNames);
}

/** Test seam. */
export function resetPluginDisplayNames(): void {
  useNameStore.setState({ names: new Map() });
}

// ru-code S38 (V2-42): the HOST's own findings about a plugin, per plugin, per page load.
//
// THE OWNER'S RULING. A plugin either loads and works or it does not; the app USER never gets a
// host message about a plugin's authoring mistakes or failures — they cannot act on one. A panel
// description the host will not draw, a seam that returned the wrong shape, a cap a plugin ran
// into, a web half that failed to load: all of that is for the person who wrote or installed the
// plugin, and they have the browser console, the server debug log and this record.
//
// It lives here because this file already IS "what happened to each plugin in this page load", and
// because the Plugins settings page (V2-43 / S38 step 9) renders one row per plugin: its state and
// what the host had to say about it, side by side, out of one module.
//
// REACTIVE, for the reason `recordPluginDisplayName` is: plugins load AFTER first paint and the
// settings page is open before they do, so a plain array would show an empty list until some
// unrelated repaint (rules §26).

/** One thing the host had to say about one plugin, with how many times it said it. */
export interface PluginProblemRecord {
  readonly pluginId: string;
  /** The problem's CATEGORY, supplied by the host at the call site (`seam:panels`, `cap:pages`). */
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  /** How many times this `(pluginId, code)` happened. The first one is the one that is logged. */
  readonly count: number;
}

interface ProblemState {
  /** Replaced, never mutated: the identity IS the change signal `useSyncExternalStore` compares. */
  readonly problems: ReadonlyArray<PluginProblemRecord>;
}

const useProblemStore = create<ProblemState>(() => ({ problems: [] }));

/**
 * Record one host finding. Repeats of the same `(pluginId, code)` bump the count in place.
 *
 * Returns `true` the FIRST time a pair is seen, which is what the caller uses to decide whether to
 * write its one console line — the same R3-H4 de-duplication that used to bound the toaster.
 */
export function recordPluginProblem(problem: Omit<PluginProblemRecord, "count">): boolean {
  const { problems } = useProblemStore.getState();
  const index = problems.findIndex(
    (entry) => entry.pluginId === problem.pluginId && entry.code === problem.code,
  );
  if (index < 0) {
    useProblemStore.setState({ problems: [...problems, { ...problem, count: 1 }] });
    return true;
  }
  const next = [...problems];
  const existing = next[index];
  if (existing !== undefined) next[index] = { ...existing, count: existing.count + 1 };
  useProblemStore.setState({ problems: next });
  return false;
}

/** Everything the host had to say this page load, in the order the categories first appeared. */
export function getPluginProblems(): ReadonlyArray<PluginProblemRecord> {
  return useProblemStore.getState().problems;
}

/** What the host had to say about ONE plugin. */
export function pluginProblemsOf(
  problems: ReadonlyArray<PluginProblemRecord>,
  id: string,
): ReadonlyArray<PluginProblemRecord> {
  return problems.filter((entry) => entry.pluginId === id);
}

/** Reactive {@link getPluginProblems} — the settings page is open before the plugins load. */
export function usePluginProblems(): ReadonlyArray<PluginProblemRecord> {
  return useSyncExternalStore(
    useProblemStore.subscribe,
    () => useProblemStore.getState().problems,
    () => useProblemStore.getState().problems,
  );
}

/** Test seam. */
export function resetPluginProblemRecords(): void {
  useProblemStore.setState({ problems: [] });
}
