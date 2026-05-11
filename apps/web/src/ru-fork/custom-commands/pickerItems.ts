import type { RuForkBuiltInCommand } from "./commands";
import { RU_FORK_BUILT_IN_COMMANDS } from "./commands";

// ru-fork: variant added to ComposerCommandItem in ComposerCommandMenu.tsx.
export interface RuForkSlashCommandComposerItem {
  id: string;
  type: "ru-fork-slash-command";
  command: RuForkBuiltInCommand;
  label: string;
  description: string;
}

export const buildRuForkSlashCommandItems = (): RuForkSlashCommandComposerItem[] =>
  RU_FORK_BUILT_IN_COMMANDS.map((command) => ({
    id: `ru-fork-slash:${command.name}`,
    type: "ru-fork-slash-command",
    command,
    label: `/${command.name}`,
    description: command.description,
  }));
