/**
 * ru-code: the meter-denominator decision — which context window (in tokens)
 * applies to the model a thread is currently running. One pure function so the
 * two token-usage emit sites and the tests share the exact same fallback chain:
 *
 *   served entry's `nTokens` (profile-owned / discovered contextLimit / custom
 *   suffix) → the slug's own `-256k` size suffix → CONTEXT_WINDOW_TOKENS.
 *
 * @module ru-code/qwen/discovery/resolveQwenModelContextWindow
 */
import type { QwenSettings } from "@t3tools/contracts";

import { CONTEXT_WINDOW_TOKENS } from "@ru-code/qwen/constants";
import { parseContextWindowFromSlug } from "@ru-code/qwen/models/modelToken";

import type { DiscoveredQwenModel } from "./QwenModelDiscoveryStore.ts";
import { serveQwenModels } from "./serveQwenModels.ts";

export function resolveQwenModelContextWindow(
  settings: QwenSettings,
  discoveredModels: ReadonlyArray<DiscoveredQwenModel>,
  modelSlug: string | undefined,
): number {
  if (modelSlug !== undefined && modelSlug.length > 0) {
    const servedEntry = serveQwenModels(settings, discoveredModels).find(
      (model) => model.slug === modelSlug,
    );
    if (servedEntry?.nTokens !== undefined && servedEntry.nTokens > 0) {
      return servedEntry.nTokens;
    }
    const parsedWindow = parseContextWindowFromSlug(modelSlug);
    if (parsedWindow !== null) return parsedWindow;
  }
  return CONTEXT_WINDOW_TOKENS;
}
