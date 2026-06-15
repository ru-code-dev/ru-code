import { describe, expect, it } from "vitest";

import { DesignerId, NodeId, ResultTag } from "../src/ids.ts";
import { decode, rejects } from "./decode.ts";

describe("DesignerId", () => {
  it("decodes and trims a valid key", async () => {
    expect(await decode(DesignerId, "  dz_alice  ")).toBe("dz_alice");
  });
  it("rejects empty / whitespace-only", async () => {
    expect(await rejects(DesignerId, "")).toBe(true);
    expect(await rejects(DesignerId, "   ")).toBe(true);
  });
  it("rejects over 200 chars", async () => {
    expect(await rejects(DesignerId, "x".repeat(201))).toBe(true);
    expect(await decode(DesignerId, "x".repeat(200))).toBe("x".repeat(200));
  });
  it("rejects non-strings", async () => {
    expect(await rejects(DesignerId, 42)).toBe(true);
  });
});

describe("NodeId", () => {
  it("decodes a non-empty id", async () => {
    expect(await decode(NodeId, "node-1")).toBe("node-1");
  });
  it("rejects empty", async () => {
    expect(await rejects(NodeId, "")).toBe(true);
  });
});

describe("ResultTag", () => {
  it("decodes a valid tag", async () => {
    expect(await decode(ResultTag, "react")).toBe("react");
  });
  it("rejects empty and over 64 chars", async () => {
    expect(await rejects(ResultTag, "")).toBe(true);
    expect(await rejects(ResultTag, "t".repeat(65))).toBe(true);
    expect(await decode(ResultTag, "t".repeat(64))).toBe("t".repeat(64));
  });
});
