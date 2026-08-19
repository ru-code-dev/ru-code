// ru-code: split an inline `slug(auth)` suffix off a custom-model slug — the fix
// for the user's old `slug(auth-method)` habit that would otherwise double-encode
// (`slug(auth)(auth)` → qwen 404).
import { describe, expect, it } from "vite-plus/test";
import { AUTH_METHOD_IDS } from "@ru-code/branding";

import { parseSlugWithAuth } from "../../cliProfiles/parseSlugWithAuth";

describe("parseSlugWithAuth", () => {
  it("splits a known trailing auth suffix into { slug, authMethod }", () => {
    expect(parseSlugWithAuth("my-model(openai)")).toEqual({
      slug: "my-model",
      authMethod: "openai",
    });
  });

  it("recognizes every known auth id (incl. hyphenated ones)", () => {
    for (const id of AUTH_METHOD_IDS) {
      expect(parseSlugWithAuth(`m(${id})`)).toEqual({ slug: "m", authMethod: id });
    }
  });

  it("leaves a plain slug untouched", () => {
    expect(parseSlugWithAuth("my-model")).toEqual({ slug: "my-model" });
  });

  it("does NOT split an unknown auth suffix — keeps the literal slug", () => {
    expect(parseSlugWithAuth("my-model(bogus)")).toEqual({ slug: "my-model(bogus)" });
  });

  it("keeps a namespaced slug's base intact when splitting", () => {
    expect(parseSlugWithAuth("org/model(anthropic)")).toEqual({
      slug: "org/model",
      authMethod: "anthropic",
    });
  });

  it("trims surrounding and inner whitespace", () => {
    expect(parseSlugWithAuth("  m ( qwen-oauth ) ")).toEqual({
      slug: "m",
      authMethod: "qwen-oauth",
    });
  });

  it("does not produce an empty slug from a bare `(auth)`", () => {
    expect(parseSlugWithAuth("(openai)")).toEqual({ slug: "(openai)" });
  });

  it("handles an empty / whitespace-only input", () => {
    expect(parseSlugWithAuth("")).toEqual({ slug: "" });
    expect(parseSlugWithAuth("   ")).toEqual({ slug: "" });
  });

  it("peels only the final suffix when several are present", () => {
    // greedy end-anchored match strips the last `(auth)` group only
    expect(parseSlugWithAuth("m(openai)(anthropic)")).toEqual({
      slug: "m(openai)",
      authMethod: "anthropic",
    });
  });
});
