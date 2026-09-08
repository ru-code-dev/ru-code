// ru-code (A22, SDK 0.3.0): `host.composer.registerProvider({ trigger, useRows })` — DYNAMIC
// composer rows.
//
// WHY, IN ONE PARAGRAPH. `registerItem` is static: the row set is fixed in `activate()`. A plugin
// that owns a CATALOG of things (skills, agents, custom commands) has a row set that is a function
// of `(its snapshot × the active project × the query)` and changes on every rescan, connect,
// disable and project switch — and easily exceeds the cap of 20. It also needs sections and row
// glyphs, and the app needs to be able to ask, synchronously at SEND time, whether a typed
// `/name` is one of the rows. `registerItem` gives none of that (PHASE3 plan §2.5.2, G1–G5).
//
// THE SHAPE: `useRows(query)` IS A HOOK. The plugin's React is the host's React (D13), so a hook
// is a shape the plugin can already write, and it buys reactivity for free — a panel mutation
// repaints the open picker in the same commit — plus a readable row set for the submit guard. An
// async `(query) => Promise<rows>` would need a cache, a debounce and an invalidation call and
// would still lose the panel↔picker live link (recorded as the fallback, plan §6 P2).
//
// WHERE THE HOOK RUNS, AND WHY NOT IN `ChatComposer`. A plugin hook called from the composer's own
// render puts plugin code inside the app's most load-bearing component: a throw takes the composer
// down, and `renderSafety.tsx` wraps components, not hook calls. So the host mounts one INVISIBLE
// DRIVER component per provider — inside the plugin's error boundary and its `<Suspense>`, in the
// app-wide background surface — which calls `useRows(query)` and writes the rows into this store.
// `ChatComposer` reads the store exactly as it reads `pluginComposerItems(trigger, query)` today,
// and publishes the active trigger + query into it. This is the same render-nothing-driver idiom
// `CatalogAutoResync` already uses, so it is a copy, not an invention.
//
// THE QUERY IS PUBLISHED, NOT PASSED. The composer knows the active trigger and query; the drivers
// are mounted somewhere else entirely. `setActiveComposerQuery` is the one-way channel between
// them, and it is deliberately a store rather than a context: the drivers must not re-mount when
// the composer does.
//
// CAPS. 2 providers per trigger per plugin, 500 rows per query. The `registerItem` cap of 20 is
// untouched and separate — the two mechanisms coexist and a plugin may use both.

import type { PluginComposerRow, PluginComposerTrigger } from "@smart-tools/plugin-sdk/host";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

/** ru-code (A22): at most this many providers per trigger per plugin. */
export const MAX_COMPOSER_PROVIDERS_PER_TRIGGER = 2;
/**
 * ru-code (A22): the ceiling on rows one provider may return for one query.
 *
 * Not a performance guess: a menu is a list a human reads, and the failure this prevents is a
 * runaway `useRows` returning its whole unfiltered catalog on every keystroke, which renders a
 * `CommandItem` per row and makes the picker unusable rather than merely long. The excess is
 * DROPPED (never the whole provider) and the plugin is told once — the same posture every other
 * cap on this host takes.
 */
export const MAX_COMPOSER_PROVIDER_ROWS = 500;

/** The `plugin-item` menu row, as the composer menu sees it. */
type PluginComposerMenuItem = Extract<ComposerCommandItem, { type: "plugin-item" }>;

export interface RegisteredComposerProvider {
  /** `provider:<pluginId>:<trigger>:<n>` — the identity the driver is keyed by. */
  readonly key: string;
  readonly pluginId: string;
  readonly trigger: PluginComposerTrigger;
  /**
   * The invisible driver, ALREADY wrapped in this plugin's error boundary + `<Suspense>` by
   * `composerRegistry.ts`. The store deliberately does not hold the raw `PluginComposerProvider`
   * the plugin passed: every path from here to the screen must go through the boundary, and the
   * way to guarantee that is for the unwrapped value never to reach this module at all.
   */
  readonly driver: () => ReactNode;
}

interface ComposerProvidersState {
  readonly providers: ReadonlyArray<RegisteredComposerProvider>;
  /** The composer's live trigger, or `null` when no menu is open. */
  readonly activeTrigger: PluginComposerTrigger | null;
  /** The composer's live query, verbatim (un-trimmed) — providers filter it themselves. */
  readonly activeQuery: string;
  /** Rows the drivers last published, keyed by provider key. */
  readonly rows: Readonly<Record<string, ReadonlyArray<PluginComposerMenuItem>>>;
  /** Bumped whenever the rows change — the composer's `useMemo` dependency. */
  readonly revision: number;
}

const useStore = create<ComposerProvidersState>(() => ({
  providers: [],
  activeTrigger: null,
  activeQuery: "",
  rows: {},
  revision: 0,
}));

/**
 * The row id — `plugin:<pluginId>:<trigger>:<name>`, the SAME shape `registerItem` rows use
 * (`composerRegistry.ts`'s `pluginComposerItemId`).
 *
 * Deliberately the same: a plugin that migrates a row from `registerItem` to a provider keeps its
 * id, so nothing downstream (the highlight, the active-item resolution, an e2e selector) can tell
 * the difference. A collision between a plugin's item and its own provider row of the same name is
 * the plugin registering the same row twice, which is exactly what one id should mean.
 */
export function pluginComposerProviderRowId(
  pluginId: string,
  trigger: PluginComposerTrigger,
  name: string,
): string {
  return `plugin:${pluginId}:${trigger}:${name}`;
}

/** Which fields of a provider registration are unusable. Empty ⇒ well formed. */
export function invalidComposerProviderFields(provider: unknown): readonly string[] {
  if (typeof provider !== "object" || provider === null) return ["provider"];
  const candidate = provider as Record<string, unknown>;
  const invalid: string[] = [];
  // The same `try` every other registration validator on this host uses (A12 finding R3-L3): a
  // field defined as a throwing getter must be one unusable registration, not an aborted
  // `activate()`.
  try {
    if (
      typeof candidate["trigger"] !== "string" ||
      !["command", "skill", "agent"].includes(candidate["trigger"])
    ) {
      invalid.push("trigger");
    }
    if (typeof candidate["useRows"] !== "function") invalid.push("useRows");
  } catch {
    return ["provider"];
  }
  return invalid;
}

/**
 * One row as the menu sees it, or `null` when the plugin's row is unusable.
 *
 * Validated per ROW rather than per provider, and a bad row is dropped rather than failing the
 * batch: `useRows` runs on every keystroke, so one malformed entry in a computed list must cost
 * that entry and nothing else — the alternative is a picker that empties itself the moment a
 * plugin's data has one hole in it.
 */
export function toProviderMenuItem(
  pluginId: string,
  trigger: PluginComposerTrigger,
  row: PluginComposerRow,
): PluginComposerMenuItem | null {
  if (typeof row !== "object" || row === null) return null;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name === "") return null;
  if (typeof row.insert !== "string") return null;
  return {
    id: pluginComposerProviderRowId(pluginId, trigger, name),
    type: "plugin-item",
    trigger,
    pluginId,
    name,
    label: typeof row.label === "string" && row.label.trim() !== "" ? row.label : name,
    description: typeof row.description === "string" ? row.description : "",
    // The provider's `insert` string rides the EXISTING `plugin-item` insert branch as its
    // `prompt`: same `expectedText` guard, same trailing-space handling, no new insert kind and no
    // new Lexical node. That is the whole reason the SDK types `insert` as text (plan §2.5.3).
    prompt: row.insert,
    // The SDK says `insert` is "the exact text pasted … include the trailing space if you want
    // one; the host inserts it verbatim", so the host must NOT add a second one. `registerItem`
    // rows keep the historical `prompt + " "` — see `ComposerCommandMenu`'s union.
    insertVerbatim: true,
    ...(typeof row.group === "string" && row.group.trim() !== "" ? { group: row.group } : {}),
    ...(typeof row.icon === "function" || (typeof row.icon === "object" && row.icon !== null)
      ? { icon: row.icon }
      : {}),
  };
}

/** Register a provider. The caller has applied the cap; this is a pure store write. */
export function addComposerProvider(entry: RegisteredComposerProvider): void {
  useStore.setState((state) => ({
    providers: [...state.providers, entry],
    revision: state.revision + 1,
  }));
}

/** How many providers this plugin already holds for one trigger — the input to the cap. */
export function composerProviderCount(pluginId: string, trigger: PluginComposerTrigger): number {
  return useStore
    .getState()
    .providers.filter((entry) => entry.pluginId === pluginId && entry.trigger === trigger).length;
}

/** Every registered provider, in registration order — what the background surface mounts. */
export function allComposerProviders(): ReadonlyArray<RegisteredComposerProvider> {
  return useStore.getState().providers;
}

/** Reactive form of {@link allComposerProviders}, for the mount surface. */
export function useComposerProviders(): ReadonlyArray<RegisteredComposerProvider> {
  return useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().providers,
    () => useStore.getState().providers,
  );
}

/**
 * The composer publishes its live trigger + query here; the drivers read it.
 *
 * A no-op when nothing changed, so the composer may call it on every render: the drivers must
 * re-render when the QUERY changes and must not re-render when it did not.
 */
export function setActiveComposerQuery(trigger: PluginComposerTrigger | null, query: string): void {
  const state = useStore.getState();
  if (state.activeTrigger === trigger && state.activeQuery === query) return;
  useStore.setState({ activeTrigger: trigger, activeQuery: query });
}

/** What the drivers should compute for. `null` trigger ⇒ no menu is open. */
export function useActiveComposerQuery(): {
  readonly trigger: PluginComposerTrigger | null;
  readonly query: string;
} {
  const trigger = useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().activeTrigger,
    () => useStore.getState().activeTrigger,
  );
  const query = useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().activeQuery,
    () => useStore.getState().activeQuery,
  );
  return { trigger, query };
}

/**
 * One driver's rows, published into the store.
 *
 * Identity-compared before writing: a driver re-renders on every app render, and re-publishing an
 * identical array would bump `revision` and re-derive the composer's menu on every one of them.
 */
export function publishProviderRows(
  key: string,
  rows: ReadonlyArray<PluginComposerMenuItem>,
): void {
  const state = useStore.getState();
  const previous = state.rows[key];
  if (previous !== undefined && sameRows(previous, rows)) return;
  useStore.setState({ rows: { ...state.rows, [key]: rows }, revision: state.revision + 1 });
}

/**
 * Drop one driver's rows — its component unmounted (the plugin's boundary caught, or the surface
 * itself was torn down). Leaving them behind would keep a dead provider's rows in the menu.
 */
export function clearProviderRows(key: string): void {
  const state = useStore.getState();
  if (state.rows[key] === undefined) return;
  const { [key]: _dropped, ...rest } = state.rows;
  useStore.setState({ rows: rest, revision: state.revision + 1 });
}

/** Field-wise comparison — the drivers rebuild their arrays, so reference equality never holds. */
const sameRows = (
  left: ReadonlyArray<PluginComposerMenuItem>,
  right: ReadonlyArray<PluginComposerMenuItem>,
): boolean =>
  left.length === right.length &&
  left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.id === other.id &&
      item.label === other.label &&
      item.description === other.description &&
      item.prompt === other.prompt &&
      item.group === other.group &&
      item.icon === other.icon
    );
  });

/**
 * The rows every provider published for one trigger, in provider-registration order.
 *
 * NOT filtered by the query: a provider owns its own matching rule (a prefix, a substring, fuzzy
 * over a label it built), and the host has no way to guess it. The rows in the store are already
 * the answer for the CURRENT query, because the driver recomputed them when the query changed.
 */
export function pluginComposerProviderItems(
  trigger: PluginComposerTrigger,
): ReadonlyArray<PluginComposerMenuItem> {
  const state = useStore.getState();
  const rows: PluginComposerMenuItem[] = [];
  for (const entry of state.providers) {
    if (entry.trigger !== trigger) continue;
    const published = state.rows[entry.key];
    if (published === undefined) continue;
    rows.push(...published);
  }
  return rows;
}

/** The revision the composer's menu `useMemo` depends on. */
export function usePluginComposerProvidersRevision(): number {
  return useSyncExternalStore(
    useStore.subscribe,
    () => useStore.getState().revision,
    () => useStore.getState().revision,
  );
}

/**
 * ru-code (A22, plan §2.5.4): the `/`-command slugs the installed plugins currently offer.
 *
 * WHY THE APP NEEDS THIS AT ALL. `resolveQwenSubmitPrompt` aborts a message that opens with an
 * UNKNOWN slash command (`qwenSlashCommands.ts` — a `/typo` must not be sent to the CLI as prose),
 * and it takes the allowlist as a PARAMETER. Today that list comes from the app's own catalog; a
 * plugin that contributes `/` rows has to be able to put its names into the same set or every one
 * of its commands is refused at send time.
 *
 * WHY IT IS READABLE SYNCHRONOUSLY. This is G5 in the plan's table, and it is the property the
 * hook shape buys: the drivers keep the store filled, so the answer is already in memory when the
 * user presses Enter. An async provider port would have had to race the send.
 *
 * THE EMPTY-QUERY SUBTLETY. The store holds the rows for the query the menu last asked for, so a
 * user who typed `/rev` and sent it has only the rows matching `rev` — which still contains the
 * command being sent, because that is what they picked it from. The case the store CANNOT answer
 * is a `/name` typed by hand with the menu never opened; `PluginCommandSlugPrime` in
 * `PluginBackgroundSurface.tsx` covers exactly that by keeping one driver per `command` provider
 * mounted at the EMPTY query, always (plan §6 P5).
 */
export function pluginCommandSlugs(): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const item of pluginComposerProviderItems("command")) {
    slugs.add(item.name.toLowerCase());
  }
  for (const item of primedCommandSlugs()) slugs.add(item);
  return slugs;
}

/** Rows published by the always-on empty-query command drivers. See {@link pluginCommandSlugs}. */
const primedRows = new Map<string, ReadonlyArray<string>>();

export function publishPrimedCommandSlugs(key: string, names: ReadonlyArray<string>): void {
  const previous = primedRows.get(key);
  if (
    previous !== undefined &&
    previous.length === names.length &&
    previous.every((name, index) => name === names[index])
  ) {
    return;
  }
  primedRows.set(key, names);
  // The slug set is read imperatively at send time, so nothing has to re-render for it — but the
  // revision is what a TEST (and any future reactive reader) observes.
  useStore.setState((state) => ({ revision: state.revision + 1 }));
}

const primedCommandSlugs = (): ReadonlyArray<string> => [...primedRows.values()].flat();

/**
 * ru-code (A22, plan §2.5.4): the hook form of {@link pluginCommandSlugs}, for the send path.
 *
 * `ChatView` holds the allowlist as state and passes it into `resolveQwenSubmitPrompt`, so the set
 * has to be a HOOK that re-renders when the rows change — the imperative reader alone would freeze
 * whatever the first render saw. The revision is the subscription; the set is rebuilt from the
 * store whenever it moves.
 */
export function usePluginCommandSlugs(): ReadonlySet<string> {
  const revision = usePluginComposerProvidersRevision();
  return useMemo(() => pluginCommandSlugs(), [revision]);
}

/** Test seam — clears providers, rows, primed slugs and the published query. */
export function resetPluginComposerProviders(): void {
  primedRows.clear();
  useStore.setState({
    providers: [],
    activeTrigger: null,
    activeQuery: "",
    rows: {},
    revision: 0,
  });
}
