/**
 * ru-code: context-window usage thresholds + colors for the token meter.
 * Single place to tune the warning/danger bands and their theme tokens.
 *
 * @module ru-code/tokens-usage/constants
 */

/** Percent of a model's context window consumed at which the meter warns. */
export const WARNING_USED_PERCENT = 50;

/**
 * Percent of a model's context window consumed at which the meter turns red.
 * 70 mirrors qwen's COMPRESSION_TOKEN_THRESHOLD (0.7). qwen does NOT auto-compact
 * (its snapshot reports compactsAutomatically === false), so red is the signal to
 * run /compress manually before the context hits the hard window limit.
 */
export const DANGER_USED_PERCENT = 70;

/**
 * Ring stroke color per fill level. Project semantic theme tokens (Tailwind v4
 * palette vars already used by the port meter), so they adapt to light/dark and
 * every theme automatically (see index.css).
 */
export const CONTEXT_USAGE_COLOR = {
  normal: "var(--color-muted-foreground)",
  warning: "var(--color-amber-500)",
  danger: "var(--color-red-500)",
} as const;

/**
 * Ring color when the bands are OFF (auto-compacting providers like Codex/Claude,
 * or an unknown window). Keeps the port meter's original neutral blue look.
 */
export const CONTEXT_METER_NEUTRAL_COLOR = "var(--color-blue-500)";
