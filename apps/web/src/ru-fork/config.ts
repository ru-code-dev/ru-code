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

// ru-fork: advanced chat mode diff renderer. true = rich @pierre/diffs FileDiff
// (clean gutter, no patch headers); false = raw Shiki unified-patch fallback.
// Flip to false to fall back instantly if the rich renderer misbehaves.
export const ADVANCED_CHAT_RICH_DIFF = true;

// ru-fork: advanced chat mode — preview a pending file operation before it is
// approved/applied. true = render an un-applied `edit` as a synthesized
// old→new diff (jsdiff createTwoFilesPatch) and a pending `write_file` as a
// syntax-highlighted code block; false = just show the raw call arguments.
// Orthogonal to ADVANCED_CHAT_RICH_DIFF, which only styles a diff once shown.
export const ADVANCED_CHAT_PENDING_PREVIEW = true;
