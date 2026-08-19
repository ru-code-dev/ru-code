// ru-code: the composer mode-control catalogs + change guard as one shared source, so
// the runtime-access radio and the interaction (plan) radio render from data instead of
// duplicated JSX, and the "ignore a no-op / empty selection" guard can't drift between
// the two groups. CompactComposerControlsMenu renders straight from these (R6); locking
// them here guarantees the option SET, labels, full-access gating, and the
// plan-reflects-interactionMode selection are the tested decision, not markup fragments.
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

export interface ModeOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

// ru-code: the catalog owns which modes it offers (C-05-014, Option A — "auto" is
// deliberately not in the menu; every shipped adapter treats it as a Supervised
// synonym). Narrowing the catalog's own value type to what it actually lists — rather
// than the full `RuntimeMode` contracts union — keeps `runtimeModeIcons` (the presentational
// map in ChatComposer) exhaustive over the 3 real entries without touching
// `packages/contracts/src/orchestration.ts`'s `RuntimeMode`, which still carries all 4
// members for every adapter that interprets them.
export type ComposerRuntimeMode = Exclude<RuntimeMode, "auto">;

export interface RuntimeModeCatalogEntry extends ModeOption<ComposerRuntimeMode> {
  /** The long explanation the wide footer select renders under the label. */
  readonly description: string;
}

/**
 * Runtime-access modes in display order (least → most permissive). The ONE
 * catalog both composer variants render from — the compact menu takes
 * value/label, the wide footer select additionally renders the description
 * (its icons stay presentational in the component).
 */
export const RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeModeCatalogEntry> = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

/** Interaction modes — the plan toggle's two states. */
export const INTERACTION_MODE_OPTIONS: ReadonlyArray<ModeOption<ProviderInteractionMode>> = [
  // ru-code: "Chat" — the merge keeps t3's current wording for the non-planning
  // mode rather than 05's "Build" (decisions.md row 19).
  { value: "default", label: "Chat" },
  { value: "plan", label: "Plan" },
];

export interface RuntimeModeOption extends RuntimeModeCatalogEntry {
  /** full-access is locked for providers that forbid it; every other mode is free. */
  readonly disabled: boolean;
}

/**
 * The runtime-access radio's rendered options: the full catalog, with full-access
 * disabled when the active provider forbids it (`fullAccessDisabled`). The catalog
 * (which modes exist, in what order, with what labels) is fixed; only full-access's
 * enabled state varies.
 */
export function resolveRuntimeModeOptions(input: {
  readonly fullAccessDisabled: boolean;
}): ReadonlyArray<RuntimeModeOption> {
  return RUNTIME_MODE_OPTIONS.map((option) => ({
    ...option,
    disabled: option.value === "full-access" ? input.fullAccessDisabled : false,
  }));
}

/**
 * Whether a radio-group change should be applied: a real value that differs from the
 * current one. A null/empty payload (deselect) or picking the already-selected value
 * is a no-op — the shared guard for both mode radios.
 */
export function shouldApplyModeControlChange<TValue extends string>(
  next: TValue | null | undefined,
  current: TValue,
): boolean {
  return Boolean(next) && next !== current;
}
