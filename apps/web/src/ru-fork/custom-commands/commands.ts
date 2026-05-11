// ru-fork: locally-defined slash commands shown in the composer `/` picker.
// They map 1:1 to cli-code v0.13.1 built-in ACP commands, but the Russian
// descriptions are owned here so we don't depend on `available_commands_update`.
import { CLI_NAME } from "@ru-fork/branding";

const CLI_CONTEXT_FILE = `${CLI_NAME.toUpperCase()}.md`;

export interface RuForkBuiltInCommand {
  name: string;
  description: string;
}

export const RU_FORK_BUILT_IN_COMMANDS: ReadonlyArray<RuForkBuiltInCommand> = [
  { name: "init", description: `Проанализировать проект и создать ${CLI_CONTEXT_FILE}` },
  {
    name: "summary",
    description: `Создать сводку проекта и сохранить в .${CLI_NAME}/PROJECT_SUMMARY.md`,
  },
  { name: "compress", description: "Уплотнить историю диалога для экономии контекста" },
  {
    name: "review",
    description: "Код-ревью изменений; можно указать номер PR или путь к файлу",
  },
];

// ru-fork: RU_FORK_SLASH_COMMAND_{EDITOR,BUBBLE}_REGEX moved to
// unsupported-slash-commands/chipRegex.ts so the regex source can include
// the rewrite stubs (/agents, /skills, /mcp) without polluting this list
// with non-CLI commands.

const BY_NAME = new Map(RU_FORK_BUILT_IN_COMMANDS.map((c) => [c.name, c]));

export const findRuForkBuiltInCommand = (name: string): RuForkBuiltInCommand | undefined =>
  BY_NAME.get(name);
