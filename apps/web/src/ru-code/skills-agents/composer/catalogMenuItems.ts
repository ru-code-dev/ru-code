// ru-code: catalog CatalogItem -> the port's ComposerCommandItem shape (menu rows), for both kinds.
// Isolated so ChatComposer's menu builder stays a one-line delegate per kind (fork-isolation R6). The
// `catalog-skill`/`catalog-agent` item variants are distinct from the port's native `skill` item (bound
// to ServerProviderSkill) so the port's own $skill path for non-catalog providers is never disturbed.
//
// Each row carries a `scope` ("project" | "global" | "builtin") so the menu groups into
// Проект / Глобальные / Встроенные sections. The visible `label` is the formatted display name, EXCEPT
// when two items in this list would format to the same string (look-alikes) — then the raw name is
// shown so they stay distinguishable. The `name` (identity, used to build the delimited token) is
// always the real name.
import {
  ambiguousDisplayNames,
  formatCatalogItemDisplayName,
  type CatalogItem,
} from "@smart-tools/qwen-cli-catalog-core/contracts";
import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

// A catalog item is "project scope" when it is bound + enabled to the ACTIVE project; otherwise it is
// effective via the global scope. (The composer's item list is already the project's effective set.)
const scopeOf = (item: CatalogItem, projectId: string | null): "project" | "global" =>
  item.bindings.some(
    (binding) => binding.enabled && binding.scope === "project" && binding.projectId === projectId,
  )
    ? "project"
    : "global";

export const catalogSkillMenuItems = (
  items: ReadonlyArray<CatalogItem>,
  projectId: string | null,
): ReadonlyArray<Extract<ComposerCommandItem, { type: "catalog-skill" }>> => {
  const ambiguous = ambiguousDisplayNames(items);
  return items.map((item) => ({
    id: `catalog-skill:${item.name}`,
    type: "catalog-skill" as const,
    name: item.name,
    label: ambiguous.has(item.name) ? item.name : formatCatalogItemDisplayName(item.name),
    description: item.description ?? "Skill",
    scope: scopeOf(item, projectId),
  }));
};

export const catalogAgentMenuItems = (
  items: ReadonlyArray<CatalogItem>,
  projectId: string | null,
): ReadonlyArray<Extract<ComposerCommandItem, { type: "catalog-agent" }>> => {
  const ambiguous = ambiguousDisplayNames(items);
  return items.map((item) => ({
    id: `catalog-agent:${item.name}`,
    type: "catalog-agent" as const,
    name: item.name,
    label: ambiguous.has(item.name) ? item.name : formatCatalogItemDisplayName(item.name),
    description: item.description ?? "Agent",
    scope: scopeOf(item, projectId),
  }));
};

// ru-code: catalog custom commands for the `/` picker. The label shows `/name` (the invocation), and
// the name stays the raw slug — the composer inserts `/name ` and qwen runs it as a slash command.
export const catalogCommandMenuItems = (
  items: ReadonlyArray<CatalogItem>,
  projectId: string | null,
): ReadonlyArray<Extract<ComposerCommandItem, { type: "catalog-command" }>> =>
  items.map((item) => ({
    id: `catalog-command:${item.name}`,
    type: "catalog-command" as const,
    name: item.name,
    label: `/${item.name}`,
    description: item.description ?? "Command",
    scope: scopeOf(item, projectId),
  }));
