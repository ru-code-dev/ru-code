/**
 * ru-fork: the one place that turns (usedTokens, model window) into the facts
 * the UI needs. The model dropdown (capacity gating) and the context meter
 * (fill %, color) both call these — no window math is duplicated.
 *
 * @module ru-fork/tokens-usage/usage
 */
import {
  CONTEXT_USAGE_COLOR,
  DANGER_USED_PERCENT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  WARNING_USED_PERCENT,
} from "./constants";

/** Minimal shape we read off a model option / snapshot model. */
export type WindowedModel = { readonly contextWindowTokens?: number | undefined };

/** Resolve a model's window, falling back to the default when undeclared. */
export function modelContextWindow(model: WindowedModel): number {
  return model.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** Percent (0–100+) of the model's window consumed; 0 when window unknown. */
export function contextUsedPercent(usedTokens: number, model: WindowedModel): number {
  const windowTokens = modelContextWindow(model);
  return windowTokens > 0 ? (usedTokens / windowTokens) * 100 : 0;
}

/**
 * Dropdown gate: can this model physically hold the existing conversation?
 * Unknown usage (null) or unknown window (0) → always selectable.
 */
export function canHoldContext(model: WindowedModel, usedTokens: number | null): boolean {
  if (usedTokens === null) return true;
  const windowTokens = modelContextWindow(model);
  if (windowTokens <= 0) return true;
  return usedTokens <= windowTokens;
}

export type ContextUsageLevel = keyof typeof CONTEXT_USAGE_COLOR;

/** Meter: which threshold band the selected model is in. */
export function contextUsageLevel(usedTokens: number, model: WindowedModel): ContextUsageLevel {
  const percent = contextUsedPercent(usedTokens, model);
  if (percent >= DANGER_USED_PERCENT) return "danger";
  if (percent >= WARNING_USED_PERCENT) return "warning";
  return "normal";
}

/** Meter: theme color token for a usage level. */
export function contextUsageColor(level: ContextUsageLevel): string {
  return CONTEXT_USAGE_COLOR[level];
}
