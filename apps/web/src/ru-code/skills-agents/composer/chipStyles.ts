// ru-code: agent (subagent) composer chip styles. Emerald — the third distinct colour family so a
// `#agent` chip is visually distinct from a `$skill` chip (fuchsia, in composerInlineChip.ts) and a
// `/command` chip. Structure parallels the port's SKILL chip constants.
export const COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/12 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-emerald-700 align-middle dark:text-emerald-300";

// Lucide `bot` glyph — visibly distinct from the skill hexagon.
export const SUBAGENT_CHIP_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

// ru-code: chat-bubble (sent message) agent chip — same emerald family, used by CatalogInlineText.
export const CHAT_INLINE_SUBAGENT_CHIP_CLASS_NAME = COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME;
