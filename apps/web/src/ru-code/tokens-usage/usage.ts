/**
 * ru-code: the one place that turns (usedTokens, maxTokens) into the facts the
 * context meter needs (fill %, band level, color). The port snapshot supplies
 * `maxTokens` for every provider, so these take RAW tokens — no window math is
 * duplicated in the component.
 *
 * @module ru-code/tokens-usage/usage
 */
import {
  CONTEXT_METER_NEUTRAL_COLOR,
  CONTEXT_USAGE_COLOR,
  DANGER_USED_PERCENT,
  WARNING_USED_PERCENT,
} from "./constants";

export type ContextUsageLevel = "normal" | "warning" | "danger";

/**
 * Percent (0–100+, UNCLAMPED) of the model's window consumed; 0 when the window
 * is unknown (`maxTokens <= 0` or null). Unclamped on purpose: the level must be
 * able to read >100% as "danger" even though the display % is capped at 100.
 */
export function contextUsagePercent(
  usedTokens: number,
  maxTokens: number | null | undefined,
): number {
  if (maxTokens == null || maxTokens <= 0) return 0;
  return (usedTokens / maxTokens) * 100;
}

/** Meter: which threshold band the current usage is in. */
export function contextUsageLevel(
  usedTokens: number,
  maxTokens: number | null | undefined,
): ContextUsageLevel {
  if (maxTokens == null || maxTokens <= 0) return "normal";
  const percent = contextUsagePercent(usedTokens, maxTokens);
  if (percent >= DANGER_USED_PERCENT) return "danger";
  if (percent >= WARNING_USED_PERCENT) return "warning";
  return "normal";
}

/** Meter: theme color token for a usage level. */
export function contextUsageColor(level: ContextUsageLevel): string {
  return CONTEXT_USAGE_COLOR[level];
}

/**
 * Minimal usage shape the meter decision reads (subset of the port snapshot).
 * `maxTokens` is optional to match ContextWindowSnapshot under
 * exactOptionalPropertyTypes (the key may be absent, not just null).
 */
export type ContextMeterUsage = {
  readonly usedTokens: number;
  readonly maxTokens?: number | null;
  // null/undefined/absent behave as false (bands shown) — matches the snapshot default.
  readonly compactsAutomatically?: boolean | null;
};

/**
 * The WHOLE meter decision in one place: whether to show the warn/danger bands,
 * the band level, the ring color, the RU headline, and whether to surface the
 * /compress CTA. The component just applies this — no gating logic lives in JSX.
 *
 * Bands are shown ONLY for providers that don't auto-compact (qwen) AND that
 * report a known window. Codex/Claude (compactsAutomatically) and unknown-window
 * snapshots keep the neutral blue ring with no advice — the anti-leak guarantee.
 */
export type ContextMeterAdvice = {
  readonly showBands: boolean;
  readonly level: ContextUsageLevel;
  readonly ringColor: string;
  /** RU band sentence; null when there is no advice to show. */
  readonly headline: string | null;
  /** Whether to render the `/compress` call-to-action. */
  readonly showCompress: boolean;
  /** Whether the popover offers the manual "Compact context" button. */
  readonly showCompactButton: boolean;
};

export function contextMeterAdvice(usage: ContextMeterUsage): ContextMeterAdvice {
  const showBands = !usage.compactsAutomatically && usage.maxTokens != null;
  const level = showBands ? contextUsageLevel(usage.usedTokens, usage.maxTokens) : "normal";
  const ringColor = showBands ? contextUsageColor(level) : CONTEXT_METER_NEUTRAL_COLOR;
  const headline =
    level === "danger"
      ? "The context is full."
      : level === "warning"
        ? `The context is ≥ ${WARNING_USED_PERCENT}% full, which lowers answer quality.`
        : null;
  return {
    showBands,
    level,
    ringColor,
    headline,
    showCompress: level !== "normal",
    // Providers that never self-compact (qwen) get the manual "Compact context"
    // button in the meter popover — regardless of the current fill level.
    showCompactButton: !usage.compactsAutomatically,
  };
}

/**
 * Pressing "Compact context" must CLOSE the hover popover it sits in — the
 * compaction progress lives in the timeline row, not here, and a hanging
 * popover covers the composer. Order matters: close first, then dispatch
 * (dispatch may re-render the meter and re-anchor the popup).
 */
export function compactActionClosingPopover(
  closePopover: () => void,
  compactContext: () => void,
): () => void {
  return () => {
    closePopover();
    compactContext();
  };
}
