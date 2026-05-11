import { RU_FORK_BUILT_IN_COMMANDS } from "../custom-commands/commands";
import { SLASH_COMMAND_REWRITES } from "./rewriteCommands";

// ru-fork: editor + bubble chip regexes are derived from BOTH the
// cli-mapped built-ins (commands.ts) and the rewrite stubs (rewriteCommands.ts)
// so the editor recognizes `/agents`, `/skills`, `/mcp` as chips while typing.
// Bubble-side detection of the post-submit Russian text lives in
// SlashCommandInlineText.tsx (via getSlashCommandSlugForRewriteText).
const NAMES_GROUP = [
  ...RU_FORK_BUILT_IN_COMMANDS.map((c) => c.name),
  ...SLASH_COMMAND_REWRITES.map((r) => r.slug),
].join("|");

// Editor matcher — requires trailing whitespace, mirrors SKILL_TOKEN_REGEX in
// composer-editor-mentions.ts so the chip doesn't flicker mid-type.
export const RU_FORK_SLASH_COMMAND_EDITOR_REGEX = new RegExp(`^\\/(${NAMES_GROUP})(?=\\s)`);

// Bubble matcher — also accepts end-of-text, mirrors SKILL_TOKEN_REGEX in
// SkillInlineText.tsx.
export const RU_FORK_SLASH_COMMAND_BUBBLE_REGEX = new RegExp(`^\\/(${NAMES_GROUP})(?=\\s|$)`);
