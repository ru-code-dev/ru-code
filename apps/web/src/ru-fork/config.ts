// ru-fork: feature flag for hiding multi-provider UI surfaces (model
// pickers, source-control providers section) inherited from upstream t3code.
// Centralized so a single toggle controls all currently-disabled call sites.
export const HIDE_EXTRA_FEATURES = true;

// ru-fork: locks the `full-access` runtime mode (Russian label "Без
// ограничений") in the composer mode pickers. Set true to disable the
// option across every selector; flip to false to re-enable.
export const DISABLE_AUTO_APPROVE = true;

// ru-fork: shows the composer's provider/model picker independently of
// HIDE_EXTRA_FEATURES so we can re-enable model selection while keeping
// other multi-provider surfaces hidden in the single-provider build.
export const SHOW_MODEL_SELECTOR = true;
