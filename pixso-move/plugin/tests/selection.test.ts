import { describe, expect, it } from "vitest";

import type { SceneNodeLike } from "../src/code/selection.ts";
import { validateSelection } from "../src/code/selection.ts";

const node = (id: string, name: string): SceneNodeLike => ({ id, name, type: "FRAME" });

describe("validateSelection", () => {
  it("rejects an empty selection", () => {
    expect(validateSelection([])).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly one node", () => {
    expect(validateSelection([node("1", "Hero")])).toEqual({
      ok: true,
      node: { id: "1", name: "Hero" },
    });
  });

  it("rejects multiple nodes", () => {
    expect(validateSelection([node("1", "A"), node("2", "B")])).toEqual({
      ok: false,
      reason: "multiple",
    });
  });
});
