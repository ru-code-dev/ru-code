// ru-code: models the app must never LEARN about from a scan.
//
// Each entry's `fragment` is a case-insensitive SUBSTRING matched against a model's slug at
// the qwen SCAN GATE — the two pure discovery functions where models enter the app
// (`discoveredModelsFromSessionSetup` / `detectModelErrorDiscovery`). A matching model is
// dropped there, so it is never persisted, never served, and never eligible for the
// auto-default — as if the CLI never advertised it.
//
// Deliberately NOT applied to `settings.customModels` or profile built-ins: a user who types
// the slug into provider settings is adding it on purpose (the test-group path), and that
// still works. Because the gate also drops the advertisement's context window, each entry
// carries `nTokens` — the model's KNOWN window — which `serveQwenModels` uses as the window
// fallback for a manually-added matching custom model (a slug size-suffix still wins).
export const HIDE_MODELS = [{ fragment: "er-model", nTokens: 1_000_000 }] as const;

const HIDDEN_ENTRIES = HIDE_MODELS.map((entry) => ({
  fragment: entry.fragment.toLowerCase(),
  nTokens: entry.nTokens,
}));

/** True when a scanned model slug matches any HIDE_MODELS fragment (substring, case-insensitive). */
export function isHiddenModel(modelSlug: string): boolean {
  const slug = modelSlug.toLowerCase();
  return HIDDEN_ENTRIES.some((entry) => slug.includes(entry.fragment));
}

/**
 * The KNOWN context window of a hidden model, for a slug the user added manually
 * (the scan gate dropped the advertised window, so this is where it comes from).
 * Null when the slug matches no HIDE_MODELS entry.
 */
export function hiddenModelWindow(modelSlug: string): number | null {
  const slug = modelSlug.toLowerCase();
  return HIDDEN_ENTRIES.find((entry) => slug.includes(entry.fragment))?.nTokens ?? null;
}
