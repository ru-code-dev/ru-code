// ru-code: words dropped from a model's UI DISPLAY NAME — never from its slug.
//
// The slug is the routing authority (sent back to the CLI at setModel, may contain
// `/`), so it is left byte-for-byte intact. The NAME is only a human label built by
// `humanizeModelSlug`, which splits the slug into fragments on `/ - _`. Any fragment
// whose lowercase equals an entry here is dropped BEFORE the name is assembled — so
// `vllm/qwen3-coder` still dispatches as `vllm/qwen3-coder` but SHOWS as `Qwen3 Coder`.
//
// Match granularity is WHOLE FRAGMENT (case-insensitive), not substring: an entry only
// removes a standalone slug segment, never a piece of a larger word. If stripping would
// leave nothing, `humanizeModelSlug` keeps the un-stripped name instead of an empty label.
//
// Sibling of HIDE_MODELS (hiddenModels.ts): HIDE_MODELS drops the whole model at the scan
// gate; STRIP_NAME_WORDS keeps the model and only cleans its label. Add entries to hide a
// vendor/backend prefix (e.g. an inference server name) from the picker.
export const STRIP_NAME_WORDS = ["vllm"] as const;

const STRIP_WORD_SET = new Set(STRIP_NAME_WORDS.map((word) => word.toLowerCase()));

/** True when a slug fragment is a word to omit from the UI name (whole-fragment, case-insensitive). */
export function isStrippedNameWord(fragment: string): boolean {
  return STRIP_WORD_SET.has(fragment.toLowerCase());
}
