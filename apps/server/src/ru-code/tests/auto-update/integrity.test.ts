// ru-code: sha256 integrity (B8). Known-vector hash + the constant-time verify's accept/reject
// paths (match, tamper, wrong length, malformed digest).

import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { sha256Hex, verifySha256 } from "../../auto-update/integrity/sha256.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sha256Hex", () => {
  it("matches the well-known empty + 'abc' vectors", () => {
    expect(sha256Hex(bytes(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("verifySha256", () => {
  const payload = bytes("the release tarball bytes");
  const digest = NodeCrypto.createHash("sha256").update(payload).digest("hex");

  it("accepts the matching digest (any case)", () => {
    expect(verifySha256(payload, digest)).toBe(true);
    expect(verifySha256(payload, digest.toUpperCase())).toBe(true);
    expect(verifySha256(payload, ` ${digest} `)).toBe(true);
  });

  it("rejects tampered bytes and a wrong digest", () => {
    expect(verifySha256(bytes("tampered"), digest)).toBe(false);
    expect(verifySha256(payload, "0".repeat(64))).toBe(false);
  });

  it("rejects malformed digests without throwing", () => {
    expect(verifySha256(payload, "not-hex")).toBe(false);
    expect(verifySha256(payload, "abc")).toBe(false);
    expect(verifySha256(payload, "")).toBe(false);
  });
});
