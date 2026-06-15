import { describe, expect, it } from "vitest";

import { NodeRecord, NodeSummary } from "../src/node.ts";
import { decode, rejects } from "./decode.ts";

describe("NodeSummary", () => {
  it("decodes a valid summary", async () => {
    const s = await decode(NodeSummary, {
      nodeId: "n-1",
      rootName: "Card",
      addedAt: "2026-06-14T00:00:00.000Z",
      preview: "iVBOR",
    });
    expect(s.nodeId).toBe("n-1");
  });
  it("rejects a missing field", async () => {
    expect(await rejects(NodeSummary, { nodeId: "n-1", rootName: "Card" })).toBe(true);
  });
});

describe("NodeRecord", () => {
  it("decodes a full record", async () => {
    const r = await decode(NodeRecord, {
      nodeId: "n-1",
      designerId: "dz_a",
      rootName: "Card",
      nodesJson: '{"id":"1"}',
      preview: "iVBOR",
      addedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(r.designerId).toBe("dz_a");
    expect(r.nodesJson).toBe('{"id":"1"}');
  });
  it("rejects an empty designerId", async () => {
    expect(
      await rejects(NodeRecord, {
        nodeId: "n-1",
        designerId: "",
        rootName: "Card",
        nodesJson: "{}",
        preview: "iVBOR",
        addedAt: "x",
      }),
    ).toBe(true);
  });
});
