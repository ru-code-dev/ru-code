// ru-code v2: the seam RUNNERS — the whole of "the host asks every plugin for a surface".
//
// One shape, four times over (architecture.md §0):
//
//     loadedPlugins().flatMap(p => isolate(() => p.plugin.<seam>?.(p.ctx)))
//
// Every call is isolated (a throw costs that plugin's contribution and reports once), every result
// is validated against the caps (`caps.ts`), and every component that survives is mounted by
// `PluginSurface` — as an element, inside a boundary and a Suspense — never called by the host.
//
// A plugin that does not export a seam is simply absent from that surface. There is no
// registration, no ordering, and nothing for a plugin to get wrong except the shape of what it
// returns.

import type {
  ComposerRow,
  ComposerTrigger,
  InvalidateSeam,
  Page,
  Panel,
  WebCtx,
  WebPlugin,
} from "@smart-tools/plugin-sdk/host";
import { L } from "@ru-code/localization";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useProjects, useThreadShell } from "~/state/entities";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useParams } from "@tanstack/react-router";
import { getLocale } from "@ru-code/localization";

import { useActiveProjectId } from "../skills-agents/catalog/activeProject";
import { useActiveComposerTarget } from "../composer/activeComposerTarget";
import { composerTargetToken } from "./composerAttach";

import {
  MAX_BACKGROUND_PER_PLUGIN,
  MAX_COMPOSER_ROWS_PER_PLUGIN,
  MAX_LABEL_LENGTH,
  MAX_PAGES_PER_PLUGIN,
  MAX_PANELS_PER_PLUGIN,
  MAX_DESCRIPTION_LENGTH,
  isDisplayString,
  isPluginSlug,
} from "./caps";
import { useSeamVersions, type SeamVersions } from "./invalidations";
import { PluginSurface } from "./PluginSurface";
import { reportPluginProblem } from "./problems";
import { usePluginLoadPass, usePlugins, type LoadedPlugin, type PluginLoadPass } from "./registry";
import {
  activeProjectSignal,
  composerTargetSignal,
  localeSignal,
  providerSignal,
  setPluginProjects,
  themeSignal,
} from "./signals";

/** One entry a seam produced, tagged with the plugin it came from. */
export interface PluginContribution<T> {
  readonly pluginId: string;
  readonly pluginName: string;
  /** `plugin:<pluginId>:<entryId>` — unique across plugins, stable across renders. */
  readonly key: string;
  readonly value: T;
  readonly ctx: WebCtx;
}

/** Report a seam that returned something the host cannot use. Once per plugin per seam. */
const reportSeamProblem = (plugin: LoadedPlugin, seam: string, detail: string): void => {
  reportPluginProblem({
    kind: "error",
    pluginId: plugin.id,
    code: `seam:${seam}`,
    title: L(
      `Plugin "${plugin.name}" contributed nothing to ${seam}`,
      `Плагин «${plugin.name}» ничего не добавил в ${seam}`,
    ),
    detail,
  });
};

/**
 * Call one seam on one plugin, isolated. `null` means the call FAULTED.
 *
 * A throw is the plugin's problem and nobody else's: it is reported once and the plugin drops out
 * of that surface. `?? []` is not enough — a seam that is absent and a seam that exploded must
 * both leave the host with a list it can render.
 *
 * S15 A2: a list, yes — but not the same ANSWER. `[]` from an absent seam is the plugin saying
 * "nothing"; `[]` from a seam that threw is the HOST not knowing what the plugin meant. Every
 * caller that only RENDERS may keep treating the two alike (it draws nothing either way), and does
 * — `contributionsOf` turns the fault back into "this plugin contributed no entries". A caller that
 * DELETES the user's state on the strength of "not contributed" (the right panel's tab reconcile,
 * `tabSurfaces.tsx`) may not: it must know that this pass never got an answer. Hence the fault is
 * reported to the collector instead of being flattened here.
 */
const callSeam = <T,>(
  plugin: LoadedPlugin,
  seam: string,
  call: (plugin: WebPlugin, ctx: WebCtx) => ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | null => {
  try {
    const result = call(plugin.plugin, plugin.ctx);
    if (result === undefined) return [];
    if (!Array.isArray(result)) {
      reportSeamProblem(plugin, seam, `${seam}(ctx) must return an array`);
      return null;
    }
    return result;
  } catch (error) {
    reportSeamProblem(plugin, seam, error instanceof Error ? error.message : String(error));
    return null;
  }
};

// anchor: capped — mirrored by `plugin-dev/src/playground/contract.ts` (`applyHostRules`)
/** Apply the per-plugin cap, telling the plugin once when it overflowed. */
const capped = <T,>(
  plugin: LoadedPlugin,
  seam: string,
  entries: ReadonlyArray<T>,
  max: number,
): ReadonlyArray<T> => {
  if (entries.length <= max) return entries;
  reportPluginProblem({
    kind: "error",
    pluginId: plugin.id,
    code: `cap:${seam}`,
    title: L(
      `Plugin "${plugin.name}" contributed too many ${seam}`,
      `Плагин «${plugin.name}» добавил слишком много (${seam})`,
    ),
    detail: L(
      `at most ${String(max)} per plugin; the rest are ignored`,
      `не более ${String(max)} на плагин; остальные игнорируются`,
    ),
  });
  return entries.slice(0, max);
};

// anchor: isComponent — mirrored by `plugin-dev/src/playground/contract.ts`
const isComponent = (value: unknown): value is ComponentType =>
  typeof value === "function" ||
  // `memo` / `forwardRef` / `lazy` are exotic objects, and a plugin may legitimately return one.
  (typeof value === "object" && value !== null && "$$typeof" in value);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// pages / panels
// ─────────────────────────────────────────────────────────────────────────────────────────────

// anchor: validPage — mirrored by `plugin-dev/src/playground/contract.ts`. A PANEL needs exactly
// the same three things (S33 A3): its `description` is never judged here, or anywhere else — it is
// drawn as given, clamped where it is drawn (`drawnDescription`).
const validPage = (plugin: LoadedPlugin, page: unknown): page is Page => {
  const candidate = page as Partial<Page> | null;
  if (typeof candidate !== "object" || candidate === null) return false;
  if (!isPluginSlug(candidate.id)) return false;
  if (!isDisplayString(candidate.title, MAX_LABEL_LENGTH)) return false;
  return isComponent(candidate.render);
};

/** What `keepValid` tells the plugin an entry of this seam needs — beside the rule that checks it. */
const PAGE_NEEDS = "a slug `id`, a short `title` and a component `render`";

/**
 * A plugin's `description` as the host DRAWS it — the line under a tab surface's title, and the
 * second line of a composer row. The one and only rule the host applies to the field.
 *
 * THE HOST DOES NOT INSPECT A DESCRIPTION (owner, S41 item 2). It is drawn AS GIVEN. Earlier this
 * was a validator: blank, over `MAX_DESCRIPTION_LENGTH` or carrying a control character meant "draw
 * none" for a panel and — one seam over — meant DROP THE WHOLE ROW, which took a `/` row's slug out
 * of the submit allowlist and refused the user's own command at send time (S40 F5). Neither half
 * was the host's business: `description: summary ?? ""` is how an author spells an optional line,
 * a `\n` in a subtitle is a typographic accident and not a broken contribution, and the slots that
 * draw it already truncate and `line-clamp` whatever they are handed.
 *
 * So exactly two things remain, and both belong here, where the string becomes text:
 *   · not a string ⇒ `""`, which is what "the author said nothing" has always meant;
 *   · trimmed, so `""` and whitespace read the same, and CLAMPED at `MAX_DESCRIPTION_LENGTH` —
 *     a cap, never a drop, so no description can cost the surface that carries it.
 */
export const drawnDescription = (description: unknown): string =>
  typeof description === "string" ? description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";

/** Drop the entries a host surface cannot render, and say so once — naming what the seam needs. */
const keepValid = <T,>(
  plugin: LoadedPlugin,
  seam: string,
  entries: ReadonlyArray<unknown>,
  isValid: (plugin: LoadedPlugin, entry: unknown) => entry is T,
  needs: string,
): ReadonlyArray<T> => {
  const kept = entries.filter((entry): entry is T => isValid(plugin, entry));
  if (kept.length !== entries.length) {
    reportSeamProblem(
      plugin,
      seam,
      `${String(entries.length - kept.length)} entr${entries.length - kept.length === 1 ? "y" : "ies"} dropped: each needs ${needs}`,
    );
  }
  return kept;
};

/** One entry, with the id its React key is built from — computed ONCE, by {@link uniqueById}. */
interface IdentifiedEntry<T> {
  readonly id: string;
  readonly value: T;
}

/**
 * ONE entry per id within one plugin: keep the first, drop the repeats, tell the plugin once.
 *
 * `PluginContribution.key` is `plugin:<pluginId>:<entryId>` and IS the React key the app renders
 * these entries under — the sidebar footer, the right panel's launcher cards and its "+" menu, the
 * composer menu. Two entries of one plugin sharing an id pass every other gate this runner has
 * (slug, title, render, cap), so the app was handed two children with one key and React kept only
 * the first: a nav button, a card and a menu row the plugin declared vanished with no reason given
 * anywhere (S40 F2). Every other author mistake at this seam costs the ENTRY and says so; this one
 * has to do the same, through the same `seam:<name>` channel {@link keepValid} uses.
 *
 * It runs AFTER validation and BEFORE the cap, so the cap counts entries that will really be
 * contributed and an author does not lose a distinct page to a duplicate of another one. Manifest
 * order is untouched — the FIRST occurrence keeps its place.
 */
const uniqueById = <T,>(
  plugin: LoadedPlugin,
  seam: string,
  entries: ReadonlyArray<T>,
  idOf: (entry: T, index: number) => string,
): ReadonlyArray<IdentifiedEntry<T>> => {
  const kept: Array<IdentifiedEntry<T>> = [];
  const repeated = new Set<string>();
  const seen = new Set<string>();
  for (const [index, value] of entries.entries()) {
    const id = idOf(value, index);
    if (seen.has(id)) {
      repeated.add(id);
      continue;
    }
    seen.add(id);
    kept.push({ id, value });
  }
  if (repeated.size > 0) {
    const dropped = entries.length - kept.length;
    reportSeamProblem(
      plugin,
      seam,
      `${String(dropped)} entr${dropped === 1 ? "y" : "ies"} dropped: an entry \`id\` must be unique within a plugin, and ${[...repeated].map((id) => `"${id}"`).join(", ")} ${repeated.size === 1 ? "was" : "were"} repeated`,
    );
  }
  return kept;
};

const contributionsOf = <T,>(
  plugins: ReadonlyArray<LoadedPlugin>,
  seam: string,
  max: number,
  call: (plugin: WebPlugin, ctx: WebCtx) => ReadonlyArray<unknown> | undefined,
  isValid: (plugin: LoadedPlugin, entry: unknown) => entry is T,
  /** What an entry of this seam needs, for the message `keepValid` sends when one is dropped. */
  needs: string,
  /** The entry's id — or, for a seam whose entries have none, its index WITHIN THIS PLUGIN. */
  idOf: (entry: T, index: number) => string,
  /** S15 A2 — filled with the id of every plugin whose seam FAULTED on this pass, when given. */
  faulted?: Set<string>,
): ReadonlyArray<PluginContribution<T>> => {
  const out: Array<PluginContribution<T>> = [];
  for (const plugin of plugins) {
    const raw = callSeam(plugin, seam, call);
    if (raw === null) {
      faulted?.add(plugin.id);
      continue;
    }
    const valid = keepValid(plugin, seam, raw, isValid, needs);
    const distinct = uniqueById(plugin, seam, valid, idOf);
    for (const entry of capped(plugin, seam, distinct, max)) {
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        key: `plugin:${plugin.id}:${entry.id}`,
        value: entry.value,
        ctx: plugin.ctx,
      });
    }
  }
  return out;
};

/**
 * Every page every loaded plugin contributes, in manifest order.
 *
 * The COLLECTORS are exported beside the hooks, and that is deliberate: this project's web unit
 * project runs in the NODE environment (there is no jsdom or happy-dom in the repo, and adding one
 * would be a new app dependency), so a rule that only exists inside a hook is a rule only the e2e
 * suite can check. Pure in, pure out — the hooks are the two lines that make them reactive.
 */
export function collectPluginPages(
  plugins: ReadonlyArray<LoadedPlugin>,
): ReadonlyArray<PluginContribution<Page>> {
  return contributionsOf<Page>(
    plugins,
    "pages",
    MAX_PAGES_PER_PLUGIN,
    (plugin, ctx) => plugin.pages?.(ctx),
    validPage,
    PAGE_NEEDS,
    (page) => page.id,
  );
}

/**
 * One pass of the `panels` seam: what was contributed, and who failed to answer (S15 A2).
 *
 * The panels seam is the only one whose answer DELETES user state — a tab-mounted panel is a
 * persisted surface of the thread's right panel, and "not contributed" closes its tab. So this
 * seam, alone, reports its faults: a plugin in `faultedPluginIds` said nothing about its panels on
 * this pass because it threw or answered with a non-array, which is not the same statement as
 * contributing none.
 */
export interface PluginPanelsPass {
  readonly entries: ReadonlyArray<PluginContribution<Panel>>;
  /** Plugins whose `panels(ctx)` faulted on this pass. Their contributions are UNKNOWN, not empty. */
  readonly faultedPluginIds: ReadonlySet<string>;
}

export function collectPluginPanelsPass(plugins: ReadonlyArray<LoadedPlugin>): PluginPanelsPass {
  const faultedPluginIds = new Set<string>();
  const entries = contributionsOf<Panel>(
    plugins,
    "panels",
    MAX_PANELS_PER_PLUGIN,
    (plugin, ctx) => plugin.panels?.(ctx),
    (plugin, entry): entry is Panel => validPage(plugin, entry),
    PAGE_NEEDS,
    (panel) => panel.id,
    faultedPluginIds,
  );
  return { entries, faultedPluginIds };
}

/**
 * Every always-mounted component, keyed PER PLUGIN (S33 A4).
 *
 * The key is the React key of the mounted component, and the registry fills incrementally and out
 * of completion order (`addLoadedPlugin` re-sorts on every write) — so an index into the flattened
 * cross-plugin list changed whenever an earlier-sorting plugin arrived, and every change unmounted
 * and remounted a plugin that had done nothing (S28 §4.3: three mount-time invokes from one
 * fixture). The index is now the position within the plugin's own capped list, which nothing but
 * that plugin's own answer can move.
 */
export function collectPluginBackground(
  plugins: ReadonlyArray<LoadedPlugin>,
): ReadonlyArray<PluginContribution<ComponentType>> {
  return contributionsOf<ComponentType>(
    plugins,
    "background",
    MAX_BACKGROUND_PER_PLUGIN,
    (plugin, ctx) => plugin.background?.(ctx),
    (_plugin, entry): entry is ComponentType => isComponent(entry),
    "to be a component",
    (_entry, index) => `background:${String(index)}`,
  );
}

/**
 * One plugin's answer to one seam, kept until THAT plugin says it changed (V2-40).
 *
 * The plugin OBJECT is part of the key, not only its id: `addLoadedPlugin` replaces an entry when
 * the same id loads again (the e2e suite reloads the page against a changed folder), and a new
 * object is a new plugin as far as its seams are concerned.
 */
export interface SeamMemo<T> {
  readonly plugin: LoadedPlugin;
  readonly version: number;
  readonly value: T;
}

/**
 * Reuse each plugin's cached answer unless THAT plugin's version moved — the whole of V2-40's rule.
 *
 * Pure, and exported beside the collectors for the reason they are: `apps/web`'s unit project runs
 * in the NODE environment (there is no jsdom or happy-dom in this repo), so a rule that lives only
 * inside a hook is a rule only the e2e suite can check. Takes the previous memo and returns the
 * next one rather than mutating, so a caller whose render or effect was thrown away commits
 * nothing.
 *
 * The next memo holds exactly the plugins in `plugins`: an unloaded plugin's answer leaves with it.
 */
export const memoizedByPlugin = <T,>(
  previous: ReadonlyMap<string, SeamMemo<T>>,
  plugins: ReadonlyArray<LoadedPlugin>,
  versions: SeamVersions,
  of: (plugin: LoadedPlugin) => T,
): {
  readonly values: ReadonlyArray<T>;
  readonly memo: ReadonlyMap<string, SeamMemo<T>>;
} => {
  const memo = new Map<string, SeamMemo<T>>();
  const values: T[] = [];
  for (const plugin of plugins) {
    const version = versions[plugin.id] ?? 0;
    const cached = previous.get(plugin.id);
    const value =
      cached !== undefined && cached.plugin === plugin && cached.version === version
        ? cached.value
        : of(plugin);
    memo.set(plugin.id, { plugin, version, value });
    values.push(value);
  }
  return { values, memo };
};

/**
 * Ask each plugin for its own contribution — and ask ONLY the plugins whose version moved (V2-40).
 *
 * This is the runner half of `invalidations.ts`: that file makes each seam's state a map of
 * `pluginId → version` whose identity moves when the seam moved for somebody, and this one reads
 * the map twice over — as the recompute trigger (the `useMemo` dependency) and as the per-plugin
 * memo key. A plugin whose number did not move keeps the exact answer it gave, so
 * `ctx.invalidate("composer")` from the catalogs plugin no longer calls the demo plugin's `items`
 * (which builds its row with a wire call), and the SDK's "for YOUR plugin only" becomes true.
 *
 * The cache lives in a ref rather than a module: the panels seam alone has several mounted
 * consumers and `tabSurfaces.tsx:250-251` states why each keeps its own pass ("asking the seam
 * twice per render would double every fault report"). Sharing one cache across consumers would
 * change that answer for everybody; keeping one per runner changes only WHEN each runner re-asks.
 *
 * `of` must be a module-level function — a fresh closure per render would be a fresh dependency
 * per render and the memo would never hit.
 */
const useSeamContributions = <T,>(
  seam: InvalidateSeam,
  plugins: ReadonlyArray<LoadedPlugin>,
  of: (plugin: LoadedPlugin) => T,
): ReadonlyArray<T> => {
  const versions = useSeamVersions(seam);
  const memo = useRef<ReadonlyMap<string, SeamMemo<T>>>(new Map());
  return useMemo(() => {
    const next = memoizedByPlugin(memo.current, plugins, versions, of);
    memo.current = next.memo;
    return next.values;
  }, [seam, plugins, versions, of]);
};

/** The three per-plugin collectors, as module constants so the memo above can depend on them. */
const pagesOf = (plugin: LoadedPlugin): ReadonlyArray<PluginContribution<Page>> =>
  collectPluginPages([plugin]);
const panelsPassOf = (plugin: LoadedPlugin): PluginPanelsPass => collectPluginPanelsPass([plugin]);
const backgroundOf = (plugin: LoadedPlugin): ReadonlyArray<PluginContribution<ComponentType>> =>
  collectPluginBackground([plugin]);

/**
 * Reactive `collectPluginPages`.
 *
 * TWO inputs, and the second one is the whole of V2-25: `plugins` changes when a plugin LOADS, and
 * the seam versions change when a loaded plugin says its own contribution moved. Without it the
 * host would only ever re-ask on its own schedule — see `invalidations.ts` for the defect that is.
 * Which plugin's number moved decides who is re-asked (V2-40); the order is the list's, which is
 * manifest order, exactly as when every plugin was re-asked every time.
 */
export function usePluginPages(): ReadonlyArray<PluginContribution<Page>> {
  const perPlugin = useSeamContributions("pages", usePlugins(), pagesOf);
  return useMemo(() => perPlugin.flat(), [perPlugin]);
}

/** Reactive `collectPluginPanelsPass` — per plugin, on that plugin's own version (V2-25, V2-40). */
export function usePluginPanelsPass(): PluginPanelsPass {
  const perPlugin = useSeamContributions("panels", usePlugins(), panelsPassOf);
  return useMemo(
    () => ({
      entries: perPlugin.flatMap((pass) => pass.entries),
      // A plugin that faulted stays faulted in ITS OWN pass until it invalidates or reloads, which
      // is the same statement the whole-list pass made: the host has no answer from it.
      faultedPluginIds: new Set(perPlugin.flatMap((pass) => [...pass.faultedPluginIds])),
    }),
    [perPlugin],
  );
}

/** The panels themselves — the entries of the reactive pass above, for every caller that renders. */
export function usePluginPanels(): ReadonlyArray<PluginContribution<Panel>> {
  return usePluginPanelsPass().entries;
}

/** When a plugin's silence about its panels may be read as an answer (S15 A1/A2). */
export interface PanelsAuthority {
  /** The loader's outcome. Only `"read"` licenses deleting anything on "not contributed". */
  readonly pass: PluginLoadPass;
  /**
   * The plugins whose panels answer can be BELIEVED this pass: loaded, and their seam did not
   * fault. Space-joined rather than a Set because both consumers feed it to a `useEffect`
   * dependency list, where a fresh collection every render would re-run the effect on every paint.
   */
  readonly pluginIds: string;
}

/**
 * The shared rule behind BOTH state-deleting consumers of the panels seam — the right panel's tab
 * reconcile (`tabSurfaces.tsx`) and the global slot's (`slots.tsx`).
 *
 * ONE definition, because the two ran on different rules and the weaker one was a defect: a panel
 * that is not contributed means "the user's panel is gone" only when the host actually asked every
 * installed plugin and got an answer. Takes the pass it was already given rather than calling the
 * seam again — a second call per component would double every fault report.
 */
export function usePanelsAuthority(panels: PluginPanelsPass): PanelsAuthority {
  const pass = usePluginLoadPass();
  const plugins = usePlugins();
  return useMemo(
    () => ({
      pass,
      pluginIds: plugins
        .filter((plugin) => !panels.faultedPluginIds.has(plugin.id))
        .map((plugin) => plugin.id)
        .join(" "),
    }),
    [panels, pass, plugins],
  );
}

/** `""` is the empty list, not a list holding one empty id. Pairs with {@link PanelsAuthority}. */
export const splitPluginIds = (joined: string): readonly string[] =>
  joined === "" ? [] : joined.split(" ");

// ─────────────────────────────────────────────────────────────────────────────────────────────
// composer.items
// ─────────────────────────────────────────────────────────────────────────────────────────────

// anchor: validRow — mirrored by `plugin-dev/src/playground/contract.ts`. `description` is NOT
// judged here (S40 F5, owner's ruling): it is drawn as given and clamped where it is drawn
// (`drawnDescription`), exactly like a panel's, so no subtitle can cost a row — and a `/` row its
// slug in the submit allowlist.
const validRow = (row: unknown): row is ComposerRow => {
  const candidate = row as Partial<ComposerRow> | null;
  if (typeof candidate !== "object" || candidate === null) return false;
  if (!isDisplayString(candidate.id, MAX_LABEL_LENGTH)) return false;
  if (!isDisplayString(candidate.label, MAX_LABEL_LENGTH)) return false;
  if (typeof candidate.insert !== "string" || candidate.insert === "") return false;
  return candidate.group === undefined || isDisplayString(candidate.group, MAX_LABEL_LENGTH);
};

const EMPTY_ROWS: ReadonlyArray<PluginContribution<ComposerRow>> = [];

/**
 * Would re-publishing `next` show the user anything different from `shown`?
 *
 * The composer memoises its menu on the ARRAY, so an unchanged answer must keep its identity — and
 * the app's submit guard derives its allowlist from the same array, so an answer that changed must
 * lose it. Comparing KEYS alone (what this did before V2-25) satisfied only the first half: a
 * catalog item's key is built from its stable uuid, so a command RENAMED on disk came back with the
 * same key and a different `insert`, the recompute was discarded as "same", and `/newname` was
 * still refused at submit while `/oldname` was still allowed.
 *
 * So every field the host consumes is compared: the key (identity and order), and the five fields
 * a row is rendered and acted on by. Pure and exported because `apps/web`'s unit project runs in
 * the NODE environment — a rule that lives only inside a hook is a rule only the e2e suite can
 * check.
 */
export const sameComposerRows = (
  shown: ReadonlyArray<PluginContribution<ComposerRow>>,
  next: ReadonlyArray<PluginContribution<ComposerRow>>,
): boolean =>
  shown.length === next.length &&
  next.every((entry, index) => {
    const current = shown[index];
    if (current === undefined) return false;
    return (
      current.key === entry.key &&
      current.value.label === entry.value.label &&
      current.value.insert === entry.value.insert &&
      current.value.description === entry.value.description &&
      current.value.icon === entry.value.icon &&
      current.value.group === entry.value.group
    );
  });

/**
 * Rows for one open composer menu, from every plugin, in manifest order.
 *
 * ASYNC BY CONTRACT (architecture.md §2.1): `items` may return an array or a promise of one, and
 * both are the same seam — a static contribution is a constant array, a live one is a query.
 */
export async function collectPluginComposerRows(
  plugins: ReadonlyArray<LoadedPlugin>,
  trigger: ComposerTrigger,
  query: string,
): Promise<ReadonlyArray<PluginContribution<ComposerRow>>> {
  const collected = await Promise.all(
    plugins.map(async (plugin): Promise<ReadonlyArray<PluginContribution<ComposerRow>>> => {
      const items = plugin.plugin.composer?.items;
      if (items === undefined) return [];
      try {
        const answered = await items.call(plugin.plugin.composer, trigger, query, plugin.ctx);
        const valid = Array.isArray(answered) ? answered.filter(validRow) : [];
        if (Array.isArray(answered) && valid.length !== answered.length) {
          reportSeamProblem(
            plugin,
            "composer.items",
            "a row needs a short `id`, a short `label` and a non-empty `insert`",
          );
        }
        // THE SAME DEDUPE THE OTHER THREE SEAMS GET (S43 F1). `items` is async, so this seam is a
        // second pipeline and `contributionsOf` — where `uniqueById` sits — never ran for it. The
        // key below IS the menu's React key, and `toComposerCommandItem` hands it to the menu as
        // the item's `id`, which `ComposerCommandMenu` also uses for `isActive` and for cmdk's
        // `value`: two rows of one plugin sharing an `id` collided exactly as S40 F2 described,
        // and the second row vanished unreported. Between the validity filter and the cap, so the
        // cap counts rows that will really be offered — the order `contributionsOf` uses.
        const distinct = uniqueById(plugin, "composer.items", valid, (row) => row.id);
        return capped(plugin, "composer.items", distinct, MAX_COMPOSER_ROWS_PER_PLUGIN).map(
          (entry) => ({
            pluginId: plugin.id,
            pluginName: plugin.name,
            key: `plugin:${plugin.id}:${trigger}:${entry.id}`,
            value: entry.value,
            ctx: plugin.ctx,
          }),
        );
      } catch (error) {
        reportSeamProblem(
          plugin,
          "composer.items",
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    }),
  );
  return collected.flat();
}

/**
 * One plugin's rows for one open menu, kept until that plugin — or the menu — changes (V2-40).
 *
 * `rows` is the PROMISE, not the answer, and that is the whole reason this is deterministic. The
 * seam is async, so a pass takes time, and the invalidation that re-runs the runner routinely
 * arrives while the first pass is still awaiting — at boot it always does: the catalogs plugin's
 * prime lands, writes its atom and invalidates the composer while the demo plugin's `items` is
 * still waiting for `context.build`. Caching the RESULT would have nothing to cache yet, and the
 * second pass would ask that plugin all over again (measured: two `context.build` frames per
 * reload where the law says one). Caching the call means the second pass JOINS it.
 */
interface ComposerMemo {
  readonly plugin: LoadedPlugin;
  readonly version: number;
  readonly trigger: ComposerTrigger;
  readonly query: string;
  readonly rows: Promise<ReadonlyArray<PluginContribution<ComposerRow>>>;
}

/**
 * {@link collectPluginComposerRows}, asking only the plugins whose answer can have changed.
 *
 * The key carries `(trigger, query)` as well as the plugin's own version, because unlike the other
 * three seams this one is a FUNCTION of what the user typed: a keystroke re-asks everybody, which
 * is the contract (`items(trigger, query, ctx)` and "FILTER IT YOURSELF"). What it does not do any
 * more is re-ask everybody because ANOTHER plugin's data moved.
 *
 * SYNCHRONOUS on purpose: every entry — a reused call or a fresh one — is in the map before this
 * returns, so two passes in the same tick cannot both start the same plugin's `items`. A plugin
 * that has left the list leaves its entry with it. `collectPluginComposerRows` never rejects (it
 * reports a throwing seam and answers `[]`), so a cached call can never be a poisoned promise.
 */
export const memoizedComposerRows = (
  memo: Map<string, ComposerMemo>,
  plugins: ReadonlyArray<LoadedPlugin>,
  versions: SeamVersions,
  trigger: ComposerTrigger,
  query: string,
): ReadonlyArray<ComposerMemo> => {
  const entries = plugins.map((plugin): ComposerMemo => {
    const version = versions[plugin.id] ?? 0;
    const cached = memo.get(plugin.id);
    if (
      cached !== undefined &&
      cached.plugin === plugin &&
      cached.version === version &&
      cached.trigger === trigger &&
      cached.query === query
    ) {
      return cached;
    }
    const entry: ComposerMemo = {
      plugin,
      version,
      trigger,
      query,
      rows: collectPluginComposerRows([plugin], trigger, query),
    };
    memo.set(plugin.id, entry);
    return entry;
  });
  const live = new Set(plugins.map((plugin) => plugin.id));
  // Collected first: deleting from a Map while iterating its own key iterator is legal but reads
  // like a bug, and the list is at most one entry per loaded plugin.
  const gone = [];
  for (const id of memo.keys()) if (!live.has(id)) gone.push(id);
  for (const id of gone) memo.delete(id);
  return entries;
};

/**
 * Reactive {@link collectPluginComposerRows}.
 *
 * A hook with state rather than a pure derivation, because the seam may answer asynchronously. The
 * effect is keyed on `(plugins, trigger, query, versions)`: React re-runs it when the user types,
 * when a plugin loads, and when a plugin INVALIDATES the composer seam (V2-25) — the last of which
 * is what makes an answer taken before the plugin's data arrived recoverable without a remount. A
 * resolution that lands after the query moved on is DROPPED (`cancelled`), never written over the
 * newer rows, and it writes no memo either. `trigger === null` (no menu open) short-circuits
 * without calling anything.
 *
 * WHICH plugins the re-run actually asks is V2-40: the one whose version moved, and any whose rows
 * are not already cached for this exact `(trigger, query)`.
 */
export function usePluginComposerRows(
  trigger: ComposerTrigger | null,
  query: string,
): ReadonlyArray<PluginContribution<ComposerRow>> {
  const plugins = usePlugins();
  const versions = useSeamVersions("composer");
  const [rows, setRows] = useState<ReadonlyArray<PluginContribution<ComposerRow>>>(EMPTY_ROWS);
  // The rows currently on screen, so an unchanged answer does not re-render the composer menu.
  const shown = useRef(rows);
  shown.current = rows;
  const memo = useRef<Map<string, ComposerMemo>>(new Map());

  useEffect(() => {
    if (trigger === null) {
      setRows((current) => (current.length === 0 ? current : EMPTY_ROWS));
      return;
    }
    let cancelled = false;
    const entries = memoizedComposerRows(memo.current, plugins, versions, trigger, query);
    void (async () => {
      const answered = await Promise.all(entries.map((entry) => entry.rows));
      if (cancelled) return;
      const next = answered.flat();
      // Identity matters here: the composer memoises its menu on this array.
      if (!sameComposerRows(shown.current, next)) setRows(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [plugins, trigger, query, versions]);

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// background + the ctx signal bridge
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The provider instance the composer would send to on the route's own thread (V2-15).
 *
 * The two sources the app itself reads first, and NO further: the composer draft's `activeProvider`
 * (what the user picked in the composer's own switcher) and, failing that, the thread's model
 * selection. `ChatView` then applies `deriveLockedProvider` and `resolveSelectableProvider`, both of
 * which need the environment's server config to answer "…and is that provider enabled here" — app
 * POLICY, not a fact about the thread, and repeating it in the bridge would hand a plugin a value
 * that drifts the moment the policy changes.
 */
const useRouteProvider = (): string | null => {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // Narrowed STRUCTURALLY rather than on `target.kind`: the discriminants spell two ordinary
  // English words, and the localization compare-guard reads a comparison against one of those as a
  // translated string used as a key. `in` says the same thing and cannot collide with a dictionary.
  const threadRef =
    routeTarget !== null && "threadRef" in routeTarget ? routeTarget.threadRef : null;
  const draftId = routeTarget !== null && "draftId" in routeTarget ? routeTarget.draftId : null;
  const target: ComposerThreadTarget | null = threadRef ?? draftId;
  // Read both unconditionally — a hook order that depends on the route is a hook order that breaks
  // on navigation.
  const draftProvider = useComposerDraftStore((store) =>
    target === null ? null : (store.getComposerDraft(target)?.activeProvider ?? null),
  );
  const threadProvider = useThreadShell(threadRef)?.modelSelection.instanceId ?? null;
  return draftProvider ?? threadProvider;
};

/**
 * The app → `ctx` bridge (see `signals.ts`).
 *
 * Every watchable value lives behind an APP hook, and a plugin may not have an app hook — so one
 * component of the host's own reads them and pushes into the signals. It draws nothing and is
 * mounted for the life of the page, so `ctx.theme.get()` is correct from a plugin's first render.
 *
 * It is mounted inside the ROUTER (`__root.tsx`), which is what lets the route-derived three —
 * active project and provider — be read here at all.
 */
function PluginSignalBridge() {
  const locale = getLocale();
  const theme = useTheme().resolvedTheme;
  // `ctx.connection` is NOT written here (S28, V2-35): a React commit of this bridge is one step
  // behind the supervisor, so it is an atom derived from the state atom (`connectionAtom.ts`).
  const activeProject = useActiveProjectId();
  const provider = useRouteProvider();
  // V2-48: the composer the user is on, as the opaque token `ctx.composer` speaks. The app's OWN
  // route-following resolution, so a plugin's tray and the app's composer cannot disagree about
  // which draft is in front of the user.
  const composerTarget = composerTargetToken(useActiveComposerTarget());
  const appProjects = useProjects();
  // The app's own model, narrowed to the three fields the seam publishes. `name` is the project's
  // TITLE, which is what closes catalogs R3 — a port deriving it from `basename(cwd)` showed the
  // folder name for every renamed project.
  const projects = useMemo(
    () =>
      appProjects.map((project) => ({
        id: project.id,
        name: project.title,
        cwd: project.workspaceRoot,
      })),
    [appProjects],
  );

  useEffect(() => {
    localeSignal.set(locale);
  }, [locale]);
  useEffect(() => {
    themeSignal.set(theme);
  }, [theme]);
  useEffect(() => {
    activeProjectSignal.set(activeProject);
  }, [activeProject]);
  useEffect(() => {
    providerSignal.set(provider);
  }, [provider]);
  useEffect(() => {
    composerTargetSignal.set(composerTarget);
  }, [composerTarget]);
  useEffect(() => {
    setPluginProjects(projects);
  }, [projects]);

  return null;
}

/**
 * Every always-mounted, invisible plugin component, plus the signal bridge.
 *
 * Mounted ONCE in `routes/__root.tsx`, above the router: a plugin's sync loop has to keep running
 * across navigation and whether or not any of its surfaces are open. It contributes no DOM.
 */
export function PluginBackground() {
  const perPlugin = useSeamContributions("background", usePlugins(), backgroundOf);
  const components = useMemo(() => perPlugin.flat(), [perPlugin]);

  return (
    <>
      <PluginSignalBridge />
      {components.map((entry) => (
        <PluginSurface
          key={entry.key}
          pluginId={entry.pluginId}
          render={entry.value}
          surface="background"
          quiet
        />
      ))}
    </>
  );
}
