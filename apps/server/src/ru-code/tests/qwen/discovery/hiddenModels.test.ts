// ru-code: the HIDE_MODELS matcher — case-insensitive SUBSTRING of the slug. The list
// hides qwen's builtin `coder-model` (fragment "er-model") from every scan; matching is
// deliberately dumb (substring) so the behavior is predictable at a glance.
import { describe, expect, it } from "vite-plus/test";

import { HIDE_MODELS, hiddenModelWindow, isHiddenModel } from "@ru-code/branding";

describe("isHiddenModel", () => {
  it("hides the qwen builtin by fragment ('er-model' ⊂ 'coder-model')", () => {
    expect(isHiddenModel("coder-model")).toBe(true);
  });
  it("matches anywhere in the slug, any case, any provider prefix or size suffix", () => {
    expect(isHiddenModel("acme/Coder-Model-256k")).toBe(true);
    expect(isHiddenModel("CODER-MODEL")).toBe(true);
  });
  it("does not hide unrelated models", () => {
    expect(isHiddenModel("qwen/qwen3.6-35b-a3b")).toBe(false);
    expect(isHiddenModel("flash-model")).toBe(false);
    expect(isHiddenModel("acme/coder-xl-256k")).toBe(false);
  });
  it("the shipped list is exactly the entries we decided to hide, each with its KNOWN window", () => {
    expect(HIDE_MODELS).toEqual([{ fragment: "er-model", nTokens: 1_000_000 }]);
  });
});

describe("hiddenModelWindow", () => {
  it("returns the KNOWN window for a hidden slug (the scan gate dropped the advertised one)", () => {
    expect(hiddenModelWindow("coder-model")).toBe(1_000_000);
    expect(hiddenModelWindow("acme/Coder-Model")).toBe(1_000_000);
  });
  it("returns null for non-hidden slugs", () => {
    expect(hiddenModelWindow("qwen/qwen3.6-35b-a3b")).toBe(null);
    expect(hiddenModelWindow("flash-model")).toBe(null);
  });
});
