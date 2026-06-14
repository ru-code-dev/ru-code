// ru-fork: improvements-branch-3 #10 — RED test for widening the identity hash to 64-bit.
// `fnv1a` is currently 32-bit (8 hex chars); the fix makes it 64-bit (16 hex chars). These assert the
// target. No production logic touched.

import { fnv1a } from "@ru-fork/mcp-core";
import { describe, expect, it } from "vitest";

describe("branch-3 #10 — 64-bit identity hash", () => {
  it("produces 16 hex chars (64-bit), not 8 (RED until widened)", () => {
    expect(fnv1a("anything")).toHaveLength(16);
  });

  it("is deterministic + hex", () => {
    expect(fnv1a("same")).toBe(fnv1a("same"));
    expect(fnv1a("x")).toMatch(/^[0-9a-f]+$/u);
  });

  it("distinguishes a large set of distinct inputs (no collision in the sample)", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 5000; index += 1) {
      seen.add(fnv1a(`config-${index}-${index * 7}`));
    }
    expect(seen.size).toBe(5000);
  });
});
