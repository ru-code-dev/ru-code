import type { SelectionVerdict } from "../shared/messages.ts";

// Minimal structural node — testable without the Pixso runtime.
export interface SceneNodeLike {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly children?: ReadonlyArray<SceneNodeLike>;
}

// Rule: exactly ONE selected node is valid (its whole subtree comes with it).
// Zero -> "empty"; more than one -> "multiple" (ctrl/shift multi-select of unrelated items).
export const validateSelection = (
  selection: ReadonlyArray<SceneNodeLike>,
): SelectionVerdict => {
  if (selection.length === 0) return { ok: false, reason: "empty" };
  if (selection.length > 1) return { ok: false, reason: "multiple" };
  const node = selection[0];
  if (!node) return { ok: false, reason: "empty" };
  return { ok: true, node: { id: node.id, name: node.name } };
};
