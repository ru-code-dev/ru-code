// ru-fork: subagent chip styles. Structure parallels SKILL_CHIP
// (fuchsia) and SLASH_COMMAND_CHIP (sky) — emerald is the third distinct
// color family so users can tell `#agent` from `$skill` / `/command`.
//
// Per-agent `color` from agent frontmatter is intentionally NOT applied
// here: a user-authored color can collide with the surrounding theme
// (gray text on dark bg, etc.) and there's no naive scheme that survives
// adversarial colors. The data still round-trips through the server +
// composer-side metadata so a future picker swatch / safe-color scheme
// can opt in without re-plumbing.

export const COMPOSER_INLINE_SUBAGENT_CHIP_CLASS_NAME =
  "inline-flex max-w-full select-none items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/12 px-1.5 py-px font-medium text-[12px] leading-[1.1] text-emerald-700 align-middle dark:text-emerald-300";

// Lucide `bot` glyph — visibly distinct from the skill hexagon and the
// slash-command terminal chevron.
export const SUBAGENT_CHIP_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;
