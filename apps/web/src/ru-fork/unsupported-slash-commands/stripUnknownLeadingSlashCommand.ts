import { KNOWN_SLASH_COMMAND_SLUGS } from "./knownSlashCommandSlugs";
import { getSlashCommandRewrite } from "./rewriteCommands";

const LEADING_SLASH_COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Three outcomes:
 *   - slug ∈ KNOWN_SLASH_COMMAND_SLUGS → return input verbatim (passthrough).
 *   - slug ∈ rewrite map → return the rewrite phrase (trailing user text is
 *     dropped; the bubble matches on the exact rewrite string to re-render
 *     the chip — see SlashCommandInlineText.tsx).
 *   - slug unknown → strip: return trimmed trailing text, or `null` if there
 *     was none (caller must clear the composer).
 *
 * Trims the input first so leading whitespace cannot bypass the check.
 */
export const stripUnknownLeadingSlashCommand = (text: string): string | null => {
  const trimmed = text.trim();
  const match = LEADING_SLASH_COMMAND.exec(trimmed);
  if (!match) return text;
  const slug = match[1]!.toLowerCase();
  if (KNOWN_SLASH_COMMAND_SLUGS.has(slug)) return text;
  const rewrite = getSlashCommandRewrite(slug);
  if (rewrite !== undefined) return rewrite;
  const rest = match[2]?.trim() ?? "";
  return rest === "" ? null : rest;
};
