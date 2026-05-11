import type { RuForkSlashCommandComposerItem } from "../custom-commands/pickerItems";
import { SLASH_COMMAND_REWRITES } from "./rewriteCommands";

// ru-fork: surface the rewrite slugs in the composer `/` picker. Reuses
// the existing `ru-fork-slash-command` item shape so grouping, rendering, and
// chip-insertion in ChatComposer.tsx need no special-cases — only the source
// list grows. Description is the rewrite text itself (single source per entry).
export const buildSlashCommandRewritePickerItems = (): RuForkSlashCommandComposerItem[] =>
  SLASH_COMMAND_REWRITES.map((entry) => ({
    id: `ru-fork-slash-rewrite:${entry.slug}`,
    type: "ru-fork-slash-command",
    command: { name: entry.slug, description: entry.rewrite },
    label: `/${entry.slug}`,
    description: entry.rewrite,
  }));
