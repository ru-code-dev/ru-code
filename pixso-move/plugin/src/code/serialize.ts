import { extractNodeProps } from "./nodeProps.ts";
import type { SceneNodeLike } from "./selection.ts";

// Caps guard against pathological trees: deep nesting or huge child counts. When a cap
// trips, the offending node is marked `truncated: true` and its children are dropped.
export const MAX_DEPTH = 24;
export const MAX_NODES = 5000;

interface SerializedNode {
  readonly [key: string]: unknown;
  children?: ReadonlyArray<SerializedNode>;
  truncated?: true;
}

interface WalkState {
  count: number;
  truncated: boolean;
}

const walk = (node: SceneNodeLike, depth: number, state: WalkState): SerializedNode => {
  state.count += 1;
  const serialized: SerializedNode = { ...extractNodeProps(node) };
  const children = node.children ?? [];
  if (children.length === 0) return serialized;
  if (depth >= MAX_DEPTH || state.count >= MAX_NODES) {
    state.truncated = true;
    serialized.truncated = true;
    return serialized;
  }
  serialized.children = children.map((child) => walk(child, depth + 1, state));
  return serialized;
};

export interface SerializeResult {
  readonly nodesJson: string;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

// Recursively serialize a node subtree to a JSON string (becomes IngestRequest.nodesJson).
export const serializeNode = (node: SceneNodeLike): SerializeResult => {
  const state: WalkState = { count: 0, truncated: false };
  const tree = walk(node, 0, state);
  return {
    nodesJson: JSON.stringify(tree),
    nodeCount: state.count,
    truncated: state.truncated,
  };
};
