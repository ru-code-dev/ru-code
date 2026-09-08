// ru-code: what happened to each plugin in THIS page load (mvp-plan §1.4 `status.ts`).
//
// Deliberately a plain module-level array, not a store: nothing React renders reads it. The
// REGISTRIES a plugin writes into are reactive (A4 H2/M2 — plugins load after first paint),
// but this list is a diagnostic: it exists so a human — or a later Plugins settings page
// (mvp-plan §5) — can ask why a panel is missing, and so `flushPluginProblems()` has
// something to turn into a toast. Each status is recorded the moment ITS OWN plugin settles
// (A7 finding L2) — waiting for `Promise.all` hid the healthy plugins' diagnostics for the
// whole of a hanging plugin's 10 s budget, i.e. during exactly the window someone is looking
// for the explanation. Manifest order is kept by recording the manifest INDEX beside each
// status and sorting on read, so concurrent loading still does not shuffle the list.

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
// composer port (like every per-plugin seam) is keyed by id alone. `makeWebPluginHost` knows
// both, so it records the pairing here and everything downstream looks it up.
const displayNames = new Map<string, string>();

export function recordPluginDisplayName(id: string, name: string): void {
  displayNames.set(id, name);
}

/** The plugin's manifest name, falling back to its id (never empty, never a throw). */
export function pluginDisplayName(id: string): string {
  const name = displayNames.get(id);
  return name === undefined || name.trim() === "" ? id : name;
}

/** Test seam. */
export function resetPluginDisplayNames(): void {
  displayNames.clear();
}
