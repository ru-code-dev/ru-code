// ru-code: group catalog composer rows (skills OR agents) into the Проект / Глобальные / Встроенные
// sections the `$`/`#` menus render. Kept out of the port's ComposerCommandMenu so its groupCommandItems
// stays a one-line delegate (fork-isolation R6). Empty sections are omitted; order is fixed
// Проект → Глобальные → Встроенные.
import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";

type CatalogComposerItem = Extract<
  ComposerCommandItem,
  { type: "catalog-skill" | "catalog-agent" | "catalog-command" }
>;

const isCatalogItem = (item: ComposerCommandItem): item is CatalogComposerItem =>
  item.type === "catalog-skill" || item.type === "catalog-agent" || item.type === "catalog-command";

export const groupCatalogComposerItems = (
  items: ReadonlyArray<ComposerCommandItem>,
): Array<{ id: string; label: string; items: ComposerCommandItem[] }> => {
  const bucket = (scope: "project" | "global" | "builtin"): ComposerCommandItem[] =>
    items.filter((item) => isCatalogItem(item) && item.scope === scope);

  const sections: Array<{
    id: string;
    label: string;
    scope: "project" | "global" | "builtin";
  }> = [
    { id: "cat-project", label: "Проект", scope: "project" },
    { id: "cat-global", label: "Глобальные", scope: "global" },
    { id: "cat-builtin", label: "Встроенные", scope: "builtin" },
  ];

  const groups: Array<{ id: string; label: string; items: ComposerCommandItem[] }> = [];
  for (const section of sections) {
    const bucketed = bucket(section.scope);
    if (bucketed.length > 0) {
      groups.push({ id: section.id, label: section.label, items: bucketed });
    }
  }
  return groups;
};
