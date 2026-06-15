import { describe, expect, it } from "vitest";

import type { SceneNodeLike } from "../src/code/selection.ts";
import { MAX_DEPTH, serializeNode } from "../src/code/serialize.ts";

interface Parsed {
  readonly id: string;
  readonly type: string;
  readonly children?: ReadonlyArray<Parsed>;
  readonly truncated?: true;
  readonly [key: string]: unknown;
}

const parse = (node: SceneNodeLike): Parsed =>
  JSON.parse(serializeNode(node).nodesJson) as Parsed;

describe("serializeNode", () => {
  it("serializes nested children", () => {
    const tree: SceneNodeLike = {
      id: "root",
      name: "Root",
      type: "FRAME",
      children: [{ id: "child", name: "Child", type: "TEXT" }],
    };
    const result = serializeNode(tree);
    expect(result.nodeCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(parse(tree).children?.[0]?.id).toBe("child");
  });

  it("keeps the stable prop subset and drops unknown/function props", () => {
    const tree = {
      id: "1",
      name: "Box",
      type: "RECTANGLE",
      width: 100,
      fills: [{ type: "SOLID" }],
      secret: "drop me",
      exportAsync: () => undefined,
    } as unknown as SceneNodeLike;
    const parsed = parse(tree);
    expect(parsed["width"]).toBe(100);
    expect(parsed["fills"]).toEqual([{ type: "SOLID" }]);
    expect(parsed["secret"]).toBeUndefined();
    expect(parsed["exportAsync"]).toBeUndefined();
  });

  it("handles empty children", () => {
    const parsed = parse({ id: "1", name: "Leaf", type: "TEXT", children: [] });
    expect(parsed.children).toBeUndefined();
  });

  it("marks truncated when depth cap is exceeded", () => {
    let leaf: SceneNodeLike = { id: "deep", name: "deep", type: "FRAME" };
    for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
      leaf = { id: `n${depth}`, name: "n", type: "FRAME", children: [leaf] };
    }
    expect(serializeNode(leaf).truncated).toBe(true);
  });
});
