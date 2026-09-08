// ru-code: group `plugin-item` composer rows into one section PER PLUGIN, labelled with the
// plugin's display name (mvp-plan D7).
//
// Kept out of the port's `ComposerCommandMenu` so its `groupCommandItems` stays a one-line
// delegate per family (fork-isolation R6). Since A25 this is the ONLY grouper: a catalog plugin's
// rows name their own section through `group`, so the menu renders a Проект / Глобальные section
// exactly like any other plugin section — a label plus rows, no new renderer.
//
// Section ORDER is first-appearance order in `items`, which is the order the registry produced
// them in, which is the order the plugins registered — stable across renders and independent of a
// Map's iteration order.
//
// ru-code (A22, SDK 0.3.0): a provider row may carry its own `group` label, so the section is
// `(pluginId, group ?? plugin display name)` rather than `pluginId` alone. See the loop below.

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

import { pluginDisplayName } from "./status";

type PluginComposerRow = Extract<ComposerCommandItem, { type: "plugin-item" }>;

const isPluginRow = (item: ComposerCommandItem): item is PluginComposerRow =>
  item.type === "plugin-item";

export const groupPluginComposerItems = (
  items: ReadonlyArray<ComposerCommandItem>,
): Array<{ id: string; label: string; items: ComposerCommandItem[] }> => {
  const groups: Array<{ id: string; label: string; items: ComposerCommandItem[] }> = [];
  const byKey = new Map<string, { id: string; label: string; items: ComposerCommandItem[] }>();
  for (const item of items) {
    if (!isPluginRow(item)) continue;
    // ru-code (A22, SDK 0.3.0): a PROVIDER row may name its own section (`group`) — the seam that
    // lets a plugin reproduce Проект / Глобальные / Встроенные instead of collapsing everything
    // under its own name. A `registerItem` row never carries one, so the pre-A22 behaviour (one
    // section per plugin, labelled with the plugin's display name) is exactly the `undefined` case.
    //
    // The key is SCOPED BY PLUGIN ID even when the label is the plugin's own group name: two
    // plugins that both call a section "Project" get two sections. Merging them would put one
    // plugin's rows under a heading another plugin wrote, and the whole reason the default label
    // is the plugin's name is that the reader can tell whose rows these are.
    const label = item.group ?? pluginDisplayName(item.pluginId);
    const key = `${item.pluginId}\u0000${label}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    const group = {
      id: item.group === undefined ? `plugin:${item.pluginId}` : `plugin:${item.pluginId}:${label}`,
      label,
      items: [item as ComposerCommandItem],
    };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
};
