// ru-code: the model-authority gate — qwen (and only qwen) snapshots are the
// authoritative full model set, so the registry drops its keep-absent union.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { QWEN_KIND } from "@ru-code/branding";

import { isModelsAuthoritative } from "../../qwen/modelsAuthoritative.ts";

describe("isModelsAuthoritative", () => {
  it("is true for the qwen kind", () => {
    expect(isModelsAuthoritative(ProviderDriverKind.make(QWEN_KIND))).toBe(true);
    expect(isModelsAuthoritative(ProviderDriverKind.make("qwen"))).toBe(true);
  });

  it("is false for every other driver kind", () => {
    for (const kind of ["opencode", "codex", "claudeAgent", "cursor", "grok"] as const) {
      expect(isModelsAuthoritative(ProviderDriverKind.make(kind))).toBe(false);
    }
  });

  it("is false for an undefined driver (unknown/legacy snapshot)", () => {
    expect(isModelsAuthoritative(undefined)).toBe(false);
  });
});
