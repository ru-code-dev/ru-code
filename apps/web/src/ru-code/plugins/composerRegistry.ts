// ru-code: the composer half of the web plugin host (mvp-plan D7, §1.4).
//
// Two seams, both API-only — no new Lexical node, no new trigger:
//
//  1. `registerItem` — a plugin contributes rows to the EXISTING `/` `$` `#` menus. A row is a
//     prompt: selecting it replaces the trigger text with the plugin's prompt (`ChatComposer`'s
//     insert switch, `plugin-item` branch). The trigger union in `composer-logic.ts` stays
//     closed; plugin items ride the three triggers that already exist.
//  2. `attach` / `detach` — the pixso "+" path: a context card on the ACTIVE composer draft
//     (`useComposerDraftStore.addReviewComment`), delivered with the next message.
//
// REACTIVE (A4 finding H2/M2): plugins load after the first render now, so a menu that was
// already derived must re-derive when a plugin registers. The store's `revision` is what
// `ChatComposer`'s `composerMenuItems` useMemo depends on.

import type {
  PluginComposerCard,
  PluginComposerItem,
  PluginComposerProvider,
  PluginComposerTrigger,
} from "@smart-tools/plugin-sdk/host";
import { L } from "@ru-code/localization";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import { getActiveComposerTarget, useActiveComposerTarget } from "../composer/activeComposerTarget";
import { setComposerPort, type ComposerPort } from "./composerPort";
import {
  addComposerProvider,
  composerProviderCount,
  invalidComposerProviderFields,
  pluginComposerProviderItems,
  usePluginComposerProvidersRevision,
  MAX_COMPOSER_PROVIDERS_PER_TRIGGER,
} from "./composerProviders";
import { composerProviderDriverBody } from "./PluginBackgroundSurface";
import { safePluginBackgroundRender } from "./renderSafety";
import { reportPluginProblem } from "./problems";
import { pluginDisplayName } from "./status";

/** The `plugin-item` menu row, as the composer menu sees it. */
export type PluginComposerMenuItem = Extract<ComposerCommandItem, { type: "plugin-item" }>;

interface PluginComposerItemsState {
  readonly items: ReadonlyArray<PluginComposerMenuItem>;
  /** Bumped on every registration — the useMemo dependency `ChatComposer` watches. */
  readonly revision: number;
}

const usePluginComposerItemsStore = create<PluginComposerItemsState>(() => ({
  items: [],
  revision: 0,
}));

/**
 * The row id, and the identity a duplicate registration replaces:
 * `plugin:<pluginId>:<trigger>:<name>`. Namespaced by plugin id, so two plugins may both
 * contribute a `/review` without colliding, and by trigger, so one plugin may offer the same
 * name as a command and as a skill.
 */
export function pluginComposerItemId(
  pluginId: string,
  trigger: PluginComposerTrigger,
  name: string,
): string {
  return `plugin:${pluginId}:${trigger}:${name}`;
}

const TRIGGERS: ReadonlySet<PluginComposerTrigger> = new Set(["command", "skill", "agent"]);

/** What a usable registration looks like. A malformed one is dropped, never thrown. */
function toMenuItem(pluginId: string, item: PluginComposerItem): PluginComposerMenuItem | null {
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (name === "") return null;
  if (!TRIGGERS.has(item.trigger)) return null;
  if (typeof item.prompt !== "string" && typeof item.prompt !== "function") return null;
  return {
    id: pluginComposerItemId(pluginId, item.trigger, name),
    type: "plugin-item",
    trigger: item.trigger,
    pluginId,
    name,
    label: typeof item.label === "string" && item.label.trim() !== "" ? item.label : name,
    description: typeof item.description === "string" ? item.description : "",
    prompt: item.prompt,
  };
}

/**
 * Add (or replace) one plugin composer row.
 *
 * Replace-and-continue on a duplicate id, and silently skip a malformed item: a plugin that
 * registers badly loses its row, never the menu (mvp-plan guardrail 8).
 */
export function registerComposerItem(pluginId: string, item: PluginComposerItem): void {
  const menuItem = toMenuItem(pluginId, item);
  if (menuItem === null) {
    console.warn(`[plugins] ${pluginId}: composer.registerItem ignored a malformed item`, item);
    return;
  }
  usePluginComposerItemsStore.setState((state) => {
    const index = state.items.findIndex((entry) => entry.id === menuItem.id);
    const items = [...state.items];
    if (index < 0) items.push(menuItem);
    else items[index] = menuItem;
    return { items, revision: state.revision + 1 };
  });
}

/**
 * ru-code (A22, SDK 0.3.0): register a DYNAMIC row provider.
 *
 * Three things happen here and nowhere else, which is why the port entry is this function rather
 * than a bare store write:
 *
 *  1. VALIDATION, the same posture as `toMenuItem` — a malformed provider costs the plugin its
 *     provider and is reported once, never a throw out of `activate()`;
 *  2. the CAP (2 per trigger per plugin), counted from the store so it and the store cannot
 *     disagree about what is registered;
 *  3. the BOUNDARY. `useRows` is plugin code that will run on every render of the app-wide
 *     background surface, so it is wrapped in the plugin's own error boundary + `<Suspense>`
 *     BEFORE the driver reaches the store. The unwrapped provider never leaves this function.
 */
export function registerComposerProvider(pluginId: string, provider: PluginComposerProvider): void {
  const invalid = invalidComposerProviderFields(provider);
  if (invalid.length > 0) {
    reportPluginProblem({
      kind: "error",
      pluginId,
      code: "composer-provider-invalid",
      title: L(
        `Plugin "${pluginDisplayName(pluginId)}" composer provider was skipped`,
        `Провайдер композера плагина «${pluginDisplayName(pluginId)}» пропущен`,
      ),
      detail: L(
        `invalid composer provider fields: ${invalid.join(", ")}`,
        `некорректные поля провайдера композера: ${invalid.join(", ")}`,
      ),
    });
    return;
  }
  const trigger = provider.trigger;
  const registered = composerProviderCount(pluginId, trigger);
  if (registered >= MAX_COMPOSER_PROVIDERS_PER_TRIGGER) {
    reportPluginProblem({
      kind: "error",
      pluginId,
      code: "composer-provider-overflow",
      title: L(
        `Plugin "${pluginDisplayName(pluginId)}" registered too many composer providers`,
        `Плагин «${pluginDisplayName(pluginId)}» зарегистрировал слишком много провайдеров композера`,
      ),
      detail: L(
        `at most ${String(MAX_COMPOSER_PROVIDERS_PER_TRIGGER)} providers per trigger per plugin; the rest are ignored`,
        `не более ${String(MAX_COMPOSER_PROVIDERS_PER_TRIGGER)} провайдеров на триггер на плагин; остальные игнорируются`,
      ),
    });
    return;
  }
  const key = `provider:${pluginId}:${trigger}:${String(registered)}`;
  const pluginName = pluginDisplayName(pluginId);
  addComposerProvider({
    key,
    pluginId,
    trigger,
    driver: safePluginBackgroundRender({
      pluginId,
      pluginName,
      surface: "composer-provider",
      render: composerProviderDriverBody({
        key,
        pluginId,
        trigger,
        // Bound once: the driver calls THIS function as a hook on every render, so it has to be
        // the same reference for the whole life of the mount.
        useRows: (query) => provider.useRows(query),
      }),
    }),
  });
}

/** Test seam. */
export function resetPluginComposerItems(): void {
  usePluginComposerItemsStore.setState({ items: [], revision: 0 });
}

/** Every registered row, whatever its trigger (diagnostics + tests). */
export function allPluginComposerItems(): ReadonlyArray<PluginComposerMenuItem> {
  return usePluginComposerItemsStore.getState().items;
}

/**
 * The rows one trigger's menu should show for `query`.
 *
 * The filter is the one the `#` menu's built-in section has always used — case-insensitive
 * substring over `name` OR `label` — so a plugin row behaves like every other row a reader types
 * against.
 */
export function pluginComposerItems(
  trigger: PluginComposerTrigger,
  query: string,
): ReadonlyArray<PluginComposerMenuItem> {
  const needle = query.trim().toLowerCase();
  return usePluginComposerItemsStore.getState().items.filter((item) => {
    if (item.trigger !== trigger) return false;
    if (needle.length === 0) return true;
    return item.name.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle);
  });
}

/** The revision `ChatComposer`'s menu useMemo depends on (reactive registry, A4 H2/M2).
 *
 *  `useSyncExternalStore` rather than zustand's own hook, for the same reason the panel
 *  registry uses it: zustand serves `getInitialState()` as the server snapshot, which would
 *  freeze the revision at 0 outside the browser. */
export function usePluginComposerItemsRevision(): number {
  const items = useSyncExternalStore(
    usePluginComposerItemsStore.subscribe,
    () => usePluginComposerItemsStore.getState().revision,
    () => usePluginComposerItemsStore.getState().revision,
  );
  // ru-code (A22): the PROVIDER revision rides the same number, so `ChatComposer` keeps exactly
  // one host hook call and one `useMemo` dependency whether a plugin registers items, providers
  // or both. Summed rather than tupled because the only thing the composer does with it is notice
  // that it changed.
  return items + usePluginComposerProvidersRevision();
}

/**
 * Merge the plugin rows for one trigger into a menu that was built from the app's own
 * sources. Extracted so the merge RULE is unit-testable without the 3500-line composer.
 *
 * Placement mirrors where each menu's own "ours first" convention already puts things:
 * `command` rows lead the `/` menu (the catalog's custom commands lead it today, and a
 * plugin's contribution is the same kind of thing), while `skill`/`agent` rows follow the
 * catalog and built-in sections rather than displacing them.
 */
export function mergePluginComposerItems(
  trigger: PluginComposerTrigger,
  query: string,
  items: ReadonlyArray<ComposerCommandItem>,
): ComposerCommandItem[] {
  // ru-code (A22, SDK 0.3.0): two sources now, merged at the SAME place and with the same
  // placement rule — the static `registerItem` rows and whatever the dynamic PROVIDERS published
  // for the current query (`composerProviders.ts`). Provider rows are NOT re-filtered here: a
  // provider owns its own matching rule and the store already holds the answer for this query,
  // which is exactly why the driver is given the query rather than the menu given the provider.
  //
  // Items lead providers within one trigger. A plugin's `registerItem` rows are a fixed, small,
  // author-curated set; its provider rows are a computed list that can be hundreds long, and the
  // curated ones should not end up below them.
  const plugins = [...pluginComposerItems(trigger, query), ...pluginComposerProviderItems(trigger)];
  if (plugins.length === 0) return [...items];
  return trigger === "command" ? [...plugins, ...items] : [...items, ...plugins];
}

/**
 * Resolve a row's prompt. A `string` prompt resolves synchronously at the call site; this is
 * the ASYNC path, and it never rejects — a plugin whose resolver throws gets a toast and the
 * insert becomes a no-op (mvp-plan §6 risk 2).
 */
export async function resolvePluginComposerPrompt(
  item: PluginComposerMenuItem,
): Promise<string | null> {
  if (typeof item.prompt === "string") return item.prompt;
  try {
    const prompt = await item.prompt();
    return typeof prompt === "string" ? prompt : null;
  } catch (error) {
    reportPluginProblem({
      kind: "error",
      pluginId: item.pluginId,
      // R3-H4: one toast per plugin per category, however often the row is clicked.
      code: "prompt-failed",
      title: L(`"${item.label}" could not be inserted`, `Не удалось вставить «${item.label}»`),
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return null;
  }
}

// --------------------------------------------------------------------------
// attach / detach — the pixso "+" path (D7)
// --------------------------------------------------------------------------

/** `plugin:<pluginId>:<cardId>` — namespaced so `detach` and the draft store agree. */
export function pluginCardId(pluginId: string, cardId: string): string {
  return `plugin:${pluginId}:${cardId}`;
}

/**
 * A plugin's card as the draft store's own context type.
 *
 * `ReviewCommentContext` is the shape every attached context card travels in (diff comments,
 * file comments, pixso cards): the composer chip reads `filePath` + `rangeLabel`, the tooltip
 * reads `text`, and `appendReviewCommentsToPrompt` fences `diff` into the next message. A
 * plugin only supplies `{ id, title, body }`, so the plugin's display name plays the "file"
 * and the card title plays the "range".
 */
export function pluginReviewComment(
  pluginId: string,
  card: PluginComposerCard,
): ReviewCommentContext {
  // ru-code (A13 round 3, A12 finding R3-H3, the same sweep): `card.id` was the UNCHECKED
  // substitute for a bad `title`, and it lands in `rangeLabel`/`text`, both of which are rendered.
  // A plugin whose `id` is an object could not be made to crash the browser, but it is the same
  // class of value on the same kind of path, so it is checked here too.
  const usable = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";
  const title = usable(card.title) ? card.title : usable(card.id) ? card.id : pluginId;
  return {
    id: pluginCardId(pluginId, card.id),
    sectionId: `plugin:${pluginId}`,
    sectionTitle: pluginDisplayName(pluginId),
    filePath: pluginDisplayName(pluginId),
    startIndex: 0,
    endIndex: 0,
    rangeLabel: title,
    text: title,
    diff: typeof card.body === "string" ? card.body : "",
    fenceLanguage: "text",
  };
}

/** Where an attached card lands, or `null` when the reader is not on a thread or draft. */
function activeTarget(): ComposerThreadTarget | null {
  return getActiveComposerTarget();
}

function noActiveTarget(pluginId: string): void {
  // Never a throw: the SDK types `attach` as `void`, and a plugin that attaches from a panel
  // the reader opened on the home route did nothing wrong — it just has nowhere to put it.
  reportPluginProblem({
    kind: "info",
    pluginId,
    title: L("Open a chat to attach", "Откройте чат, чтобы прикрепить"),
  });
}

export function attachPluginCard(pluginId: string, card: PluginComposerCard): void {
  const target = activeTarget();
  if (target === null) {
    noActiveTarget(pluginId);
    return;
  }
  useComposerDraftStore.getState().addReviewComment(target, pluginReviewComment(pluginId, card));
}

export function detachPluginCard(pluginId: string, cardId: string): void {
  const target = activeTarget();
  if (target === null) return;
  useComposerDraftStore.getState().removeReviewComment(target, pluginCardId(pluginId, cardId));
}

// --------------------------------------------------------------------------
// The port A3 left for this file
// --------------------------------------------------------------------------

const port: ComposerPort = {
  registerItem: registerComposerItem,
  // A22: filled in by `hostApi.ts`, which owns the cap and the boundary — a provider must never
  // reach the store unwrapped, so the port's own entry is the host-side function, not this file's.
  registerProvider: registerComposerProvider,
  attach: attachPluginCard,
  detach: detachPluginCard,
  useActiveTarget: useActiveComposerTarget,
};

let installed = false;

/** Idempotent; called by `loadPlugins()` before any `activate(host)` runs. */
export function installPluginComposerPort(): void {
  if (installed) return;
  installed = true;
  setComposerPort(port);
}

/** Test seam. */
export function resetPluginComposerPortInstall(): void {
  installed = false;
}
