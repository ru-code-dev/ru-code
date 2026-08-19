/**
 * ru-code: the SELECTED model's context window applied to the meter and the
 * picker. Two decisions live here: swap the history snapshot's `maxTokens`
 * for the selected model's served window (so the ring re-computes the moment
 * the user picks another model), and gate model rows that the current chat
 * no longer fits into. Both never act on missing data — an unreported window
 * or unknown usage keeps today's behavior.
 *
 * @module ru-code/tokens-usage/selectedModelContextWindow
 */
import type { ContextWindowSnapshot } from "../../lib/contextWindow";

/** Minimal option shape we read the served window off ({@link ModelEsque} subset). */
export type ContextWindowedOption = { readonly contextWindowTokens?: number | undefined };

/** Resolve an option's served window; null when absent or not a usable size. */
export function modelContextWindowTokens(option: ContextWindowedOption | undefined): number | null {
  const windowTokens = option?.contextWindowTokens;
  return windowTokens != null && windowTokens > 0 ? windowTokens : null;
}

/**
 * Return the snapshot with `maxTokens` swapped to the selected model's window
 * and the derived fields recomputed the exact way
 * `deriveLatestContextWindowSnapshot` does. Unknown window (null) or no
 * snapshot ⇒ the input snapshot unchanged (same reference).
 */
export function applySelectedModelWindow(
  snapshot: ContextWindowSnapshot | null,
  selectedModelWindow: number | null,
): ContextWindowSnapshot | null {
  if (snapshot === null || selectedModelWindow === null || selectedModelWindow <= 0) {
    return snapshot;
  }
  const usedPercentage = Math.min(100, (snapshot.usedTokens / selectedModelWindow) * 100);
  return {
    ...snapshot,
    maxTokens: selectedModelWindow,
    usedPercentage,
    remainingTokens: Math.max(0, Math.round(selectedModelWindow - snapshot.usedTokens)),
    remainingPercentage: Math.max(0, 100 - usedPercentage),
  };
}

/**
 * An all-zero snapshot for a chat with NO usage history yet (a draft, or a
 * thread before its first turn): the meter renders `0 / <window>` immediately
 * because the SELECTED model's window is already known. Null when the window
 * is unknown — the meter stays hidden exactly as before.
 */
export function emptyContextWindowSnapshot(
  selectedModelWindow: number | null,
): ContextWindowSnapshot | null {
  if (selectedModelWindow === null || selectedModelWindow <= 0) return null;
  return {
    usedTokens: 0,
    totalProcessedTokens: null,
    maxTokens: selectedModelWindow,
    remainingTokens: selectedModelWindow,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    // Not rendered anywhere; a fixed epoch keeps the object referentially inert.
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * Picker gate: can this model physically hold the existing conversation?
 * False ONLY when both sides are known AND the window is smaller than the
 * usage; unknown window or unknown usage ⇒ always selectable.
 */
export function canHoldContext(
  option: ContextWindowedOption | undefined,
  usedTokens: number | null,
): boolean {
  const windowTokens = modelContextWindowTokens(option);
  if (windowTokens === null || usedTokens === null) return true;
  return windowTokens >= usedTokens;
}
