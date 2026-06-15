import { describe, expect, it } from "vitest";

import { NonNegativeInt, TrimmedNonEmptyString } from "../src/base.ts";
import { decode, encode, rejects } from "./decode.ts";

describe("TrimmedNonEmptyString", () => {
  it("trims on decode", () => {
    expect(decode(TrimmedNonEmptyString, "  hi  ")).toBe("hi");
  });
  it("trims on encode", () => {
    expect(encode(TrimmedNonEmptyString, "  hi  ")).toBe("hi");
  });
  it("rejects blank", () => {
    expect(rejects(TrimmedNonEmptyString, "   ")).toBe(true);
  });
});

describe("NonNegativeInt", () => {
  it("decodes zero and positives", () => {
    expect(decode(NonNegativeInt, 0)).toBe(0);
    expect(decode(NonNegativeInt, 5)).toBe(5);
  });
  it("rejects negatives", () => {
    expect(rejects(NonNegativeInt, -1)).toBe(true);
  });
});
