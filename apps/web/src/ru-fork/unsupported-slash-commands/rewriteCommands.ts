// ru-fork: rewrite map for slash commands CLI does not implement but
// ru-fork wants to expose via natural-language prompts. The slug is shown
// in the composer `/` picker; on submit, stripUnknownLeadingSlashCommand
// replaces the `/<slug>` prefix with `rewrite` (joining trailing user text
// with a blank line) so CLI receives a plain prompt it can answer.

export interface SlashCommandRewrite {
  readonly slug: string;
  readonly rewrite: string;
}

export const SLASH_COMMAND_REWRITES: ReadonlyArray<SlashCommandRewrite> = [
  { slug: "agents", rewrite: "Отобрази список подключенных subagents" },
  { slug: "skills", rewrite: "Отобрази список подключенных bundled, project and user skill" },
  { slug: "mcp", rewrite: "Отобрази список подключенных mcp и их команды" },
];

const REWRITE_BY_SLUG: ReadonlyMap<string, string> = new Map(
  SLASH_COMMAND_REWRITES.map((entry) => [entry.slug, entry.rewrite]),
);

export const getSlashCommandRewrite = (slug: string): string | undefined =>
  REWRITE_BY_SLUG.get(slug.toLowerCase());

// Reverse lookup for the bubble renderer: when a message body equals one of
// the rewrite phrases (exact match after trim), re-render it as the original
// `/<slug>` chip so the visual UX matches what the user typed.
const SLUG_BY_REWRITE: ReadonlyMap<string, string> = new Map(
  SLASH_COMMAND_REWRITES.map((entry) => [entry.rewrite, entry.slug]),
);

export const getSlashCommandSlugForRewriteText = (text: string): string | undefined =>
  SLUG_BY_REWRITE.get(text.trim());
