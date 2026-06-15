import type { SceneNodeLike } from "./selection.ts";

// A stable subset of node properties worth carrying to the server. Pixso/Figma nodes
// expose many extra fields; we read defensively (any unknown shape) and keep only what's
// present, so the serialized JSON stays stable and small.
const SCALAR_KEYS = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "visible",
  "cornerRadius",
  "layoutMode",
  "layoutAlign",
  "layoutGrow",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "itemSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "characters",
  "fontSize",
  "fontName",
  "textAlignHorizontal",
  "letterSpacing",
  "lineHeight",
  "componentId",
  "componentProperties",
  "variantProperties",
] as const;

const ARRAY_KEYS = ["fills", "strokes", "effects"] as const;

const isPlainValue = (value: unknown): boolean =>
  value !== undefined && typeof value !== "function";

export interface SerializedProps {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

// Extract the stable property subset from a single node (no children — the caller recurses).
export const extractNodeProps = (node: SceneNodeLike): SerializedProps => {
  const source = node as unknown as Record<string, unknown>;
  const props: Record<string, unknown> = { id: node.id, name: node.name, type: node.type };
  for (const key of SCALAR_KEYS) {
    const value = source[key];
    if (isPlainValue(value)) props[key] = value;
  }
  for (const key of ARRAY_KEYS) {
    const value = source[key];
    if (Array.isArray(value) && value.length > 0) props[key] = value;
  }
  return props as SerializedProps;
};
