// ru-code: client mirror of qwen's built-in subagents
// (qwen-code/packages/core/src/subagents/builtin-agents.ts — BuiltinAgentRegistry.BUILTIN_AGENTS,
// verified 2026-07: exactly `general-purpose` + `Explore`). These are embedded in the CLI, not on
// disk and not in the catalog, so they never come through the catalog snapshot — we merge them into
// the `#` agent picker as the Встроенные (scope "builtin") section. The `name` is the exact CLI name
// (qwen looks subagents up case-insensitively but we keep the canonical spelling); the `label` is the
// formatted display. Delimited token stays `agent:⟦name⟧`, identical to a catalog agent.
import { formatCatalogItemDisplayName } from "@smart-tools/qwen-cli-catalog-core/contracts";
import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

type BuiltinAgentItem = Extract<ComposerCommandItem, { type: "catalog-agent" }>;

const builtin = (name: string, description: string): BuiltinAgentItem => ({
  id: `catalog-agent:${name}`,
  type: "catalog-agent",
  name,
  label: formatCatalogItemDisplayName(name),
  description,
  scope: "builtin",
});

export const BUILTIN_AGENT_ITEMS: ReadonlyArray<BuiltinAgentItem> = [
  builtin("general-purpose", "Code search and multi-step tasks in the repository."),
  builtin("Explore", "Fast file and code search (read-only)."),
];

// Filter the built-ins by the picker query (they are not part of the searched catalog list, so the
// composer applies the same substring match the catalog search uses — name OR label).
export const filterBuiltinAgents = (query: string): ReadonlyArray<BuiltinAgentItem> => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return BUILTIN_AGENT_ITEMS;
  return BUILTIN_AGENT_ITEMS.filter(
    (item) => item.name.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle),
  );
};
