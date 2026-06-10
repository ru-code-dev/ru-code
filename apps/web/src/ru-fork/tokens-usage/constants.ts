/**
 * ru-fork: context-window usage thresholds + colors for the token meter.
 * Single place to tune the warning/danger bands and their theme tokens.
 *
 * @module ru-fork/tokens-usage/constants
 */

/** Percent of a model's context window consumed at which the meter warns. */
export const WARNING_USED_PERCENT = 50;

/**
 * Percent of a model's context window consumed at which the meter turns red.
 * 70 mirrors qwen's COMPRESSION_TOKEN_THRESHOLD (0.7). qwen does NOT auto-compact
 * in ACP mode (its turn path uses GeminiChat directly, bypassing GeminiClient's
 * auto-compaction), so red is the signal to run /compress manually before the
 * context hits the hard window limit.
 */
export const DANGER_USED_PERCENT = 70;

/**
 * Fallback window for a model that declares no `contextWindowTokens`
 * (e.g. user custom models). 0 == unknown: the helpers treat it as
 * "no limit known" — never gate, never color.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 0;

/**
 * Ring stroke color per fill level. Project semantic theme tokens, so they
 * adapt to light/dark and every theme automatically (see index.css).
 */
export const CONTEXT_USAGE_COLOR = {
  normal: "var(--color-muted-foreground)",
  warning: "var(--color-warning)",
  danger: "var(--color-destructive)",
};
