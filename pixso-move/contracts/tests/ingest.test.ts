import { describe, expect, it } from "vitest";

import { Base64Png, IngestRequest, IngestResponse } from "../src/ingest.ts";
import { decode, rejects } from "./decode.ts";

const valid = {
  designerId: "dz_alice",
  rootName: "Login Screen",
  nodesJson: '{"id":"1"}',
  preview: "iVBORw0KGgo=",
};

describe("Base64Png", () => {
  it("decodes a non-empty string", async () => {
    expect(await decode(Base64Png, "abc")).toBe("abc");
  });
  it("rejects empty and oversize", async () => {
    expect(await rejects(Base64Png, "")).toBe(true);
    expect(await rejects(Base64Png, "x".repeat(8 * 1024 * 1024 + 1))).toBe(true);
  });
});

describe("IngestRequest", () => {
  it("decodes a valid request", async () => {
    const r = await decode(IngestRequest, valid);
    expect(r.designerId).toBe("dz_alice");
    expect(r.rootName).toBe("Login Screen");
  });
  it("rejects a missing field", async () => {
    const { preview, ...rest } = valid;
    void preview;
    expect(await rejects(IngestRequest, rest)).toBe(true);
  });
  it("rejects empty rootName and over-512 rootName", async () => {
    expect(await rejects(IngestRequest, { ...valid, rootName: "" })).toBe(true);
    expect(await rejects(IngestRequest, { ...valid, rootName: "n".repeat(513) })).toBe(true);
  });
  it("rejects too-short nodesJson", async () => {
    expect(await rejects(IngestRequest, { ...valid, nodesJson: "{" })).toBe(true);
  });
});

describe("IngestResponse", () => {
  it("decodes a node id", async () => {
    expect((await decode(IngestResponse, { nodeId: "n-1" })).nodeId).toBe("n-1");
  });
});
