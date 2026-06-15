import { describe, expect, it } from "vitest";

import { bytesToBase64 } from "../src/code/base64.ts";

const encode = (text: string): string =>
  bytesToBase64(Uint8Array.from(text, (character) => character.charCodeAt(0)));

describe("bytesToBase64", () => {
  it("encodes the empty input", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("matches known RFC 4648 vectors", () => {
    expect(encode("")).toBe("");
    expect(encode("f")).toBe("Zg==");
    expect(encode("fo")).toBe("Zm8=");
    expect(encode("foo")).toBe("Zm9v");
    expect(encode("foob")).toBe("Zm9vYg==");
    expect(encode("fooba")).toBe("Zm9vYmE=");
    expect(encode("foobar")).toBe("Zm9vYmFy");
  });

  it("encodes high bytes", () => {
    expect(bytesToBase64(Uint8Array.of(0xff, 0xff, 0xff))).toBe("////");
    expect(bytesToBase64(Uint8Array.of(0x00, 0x00, 0x00))).toBe("AAAA");
  });
});
