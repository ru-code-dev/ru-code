// ru-code: hand-seam. KeybindingsSettings.tsx builds "Conflicts with X, Y, and more."
// by interpolating a joined list and a conditional ", and more" suffix into one template
// literal — the AST dict scanner can see the surrounding phrase but not the suffix, since
// it's a string nested inside a ternary inside an interpolation slot, not a standalone
// literal. Composed by hand with L/LT instead so nothing stays untranslated.
import { L, LT } from "@ru-code/localization";

export function keybindingConflictDescription(labels: ReadonlyArray<string>): string {
  if (labels.length === 0) return "";

  const listPart = labels.slice(0, 3).join(", ");
  if (labels.length === 1) {
    return LT("Conflicts with {0}.", "Конфликтует с {0}.", [listPart]);
  }

  const suffix = labels.length > 3 ? L(", and more", ", и другие") : "";
  return LT("Conflicts with {0}{1}.", "Конфликтует с {0}{1}.", [listPart, suffix]);
}
