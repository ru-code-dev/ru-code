// ru-code: the model-token grammar `<slug>(<authMethod>)` is the single parser
// behind ACP discovery ids, backend error-prose extraction, and user-entered
// custom models — a drift here corrupts the model list on every channel, so the
// grammar gets an explicit table: size suffix math (decimal k/m), humanization,
// trusted-token acceptance/rejection, and prose extraction with the `xxx/…(…)`
// slash anchor + dedupe.
import { describe, expect, it } from "vite-plus/test";

import {
  extractModelTokens,
  humanizeModelSlug,
  parseContextWindowFromSlug,
  parseModelToken,
} from "@ru-code/qwen/models/modelToken";

describe("parseContextWindowFromSlug", () => {
  it("parses decimal k/m size suffixes", () => {
    expect(parseContextWindowFromSlug("xxx/yyy-256k")).toBe(256_000);
    expect(parseContextWindowFromSlug("xxx/yyy-256K")).toBe(256_000);
    expect(parseContextWindowFromSlug("vendor/model-1m")).toBe(1_000_000);
    expect(parseContextWindowFromSlug("vendor/model-1.5M")).toBe(1_500_000);
    expect(parseContextWindowFromSlug("vendor/model_128k")).toBe(128_000);
  });

  it("returns null when the size token is absent or malformed", () => {
    expect(parseContextWindowFromSlug("qwen3-coder-plus")).toBeNull();
    expect(parseContextWindowFromSlug("coder-model")).toBeNull();
    // Size must be the TRAILING fragment, not mid-slug.
    expect(parseContextWindowFromSlug("vendor/model-256k-preview")).toBeNull();
    // `35b` is a parameter count, not a size token.
    expect(parseContextWindowFromSlug("qwen/qwen3.6-35b-a3b")).toBeNull();
    expect(parseContextWindowFromSlug("")).toBeNull();
  });
});

describe("humanizeModelSlug", () => {
  it("splits on / - _ , capitalizes fragments, uppercases size tokens", () => {
    expect(humanizeModelSlug("xxx/yyy-xx-dfgdfg_dfgdf-256K")).toBe("Xxx Yyy Xx Dfgdfg Dfgdf 256K");
    expect(humanizeModelSlug("qwen/qwen3.6-coder-256k")).toBe("Qwen Qwen3.6 Coder 256K");
    expect(humanizeModelSlug("coder-model")).toBe("Coder Model");
    expect(humanizeModelSlug("qwen/qwen3.6-35b-a3b")).toBe("Qwen Qwen3.6 35b A3b");
  });
});

describe("parseModelToken", () => {
  it("parses the user-confirmed shape xxx/yyy-…-256K(provider)", () => {
    expect(parseModelToken("xxx/yyy-xx-dfgdfg_dfgdf-256K(provider)")).toEqual({
      slug: "xxx/yyy-xx-dfgdfg_dfgdf-256K",
      authMethod: "provider",
      nTokens: 256_000,
      name: "Xxx Yyy Xx Dfgdfg Dfgdf 256K",
    });
  });

  it("parses qwen's own formatAcpModelId ids (no slash, no size)", () => {
    expect(parseModelToken("coder-model(qwen-oauth)")).toEqual({
      slug: "coder-model",
      authMethod: "qwen-oauth",
      nTokens: null,
      name: "Coder Model",
    });
  });

  it("parses runtime-snapshot ids (pipe-separated slug)", () => {
    const parsed = parseModelToken("$runtime|openai|gpt-4(openai)");
    expect(parsed?.slug).toBe("$runtime|openai|gpt-4");
    expect(parsed?.authMethod).toBe("openai");
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelToken("  vendor/model-1m(openai)  ")?.nTokens).toBe(1_000_000);
  });

  it("rejects tokens outside the grammar", () => {
    expect(parseModelToken("no-auth-suffix")).toBeNull();
    expect(parseModelToken("()")).toBeNull();
    expect(parseModelToken("slug()")).toBeNull();
    expect(parseModelToken("(auth)")).toBeNull();
    expect(parseModelToken("spaced slug(auth)")).toBeNull();
    expect(parseModelToken("slug(spaced auth)")).toBeNull();
    expect(parseModelToken("")).toBeNull();
  });
});

describe("extractModelTokens", () => {
  it("pulls slash-anchored tokens out of arbitrary backend prose", () => {
    const details =
      "400 Model not found. Valid models are: acme/coder-xl-256k(openai), " +
      "acme/chat-mini-32k(openai) and acme/vision-1m(claude).";
    const tokens = extractModelTokens(details);
    expect(tokens.map((token) => token.slug)).toEqual([
      "acme/coder-xl-256k",
      "acme/chat-mini-32k",
      "acme/vision-1m",
    ]);
    expect(tokens[0]?.nTokens).toBe(256_000);
    expect(tokens[1]?.nTokens).toBe(32_000);
    expect(tokens[2]?.nTokens).toBe(1_000_000);
    expect(tokens[2]?.authMethod).toBe("claude");
  });

  it("never leaks trailing punctuation or quotes into the slug", () => {
    const tokens = extractModelTokens('Try "acme/coder-64k(openai)", or (acme/mini-8k(openai)).');
    expect(tokens.map((token) => token.slug)).toEqual(["acme/coder-64k", "acme/mini-8k"]);
  });

  it("requires the slash anchor — plain parenthesized words never match", () => {
    expect(extractModelTokens("Internal error (details unavailable), retry (later).")).toEqual([]);
    expect(extractModelTokens("Model 'coder-model' not found for authType 'openai'")).toEqual([]);
  });

  it("dedupes by slug in first-seen order", () => {
    const tokens = extractModelTokens("a/b-8k(x) then a/b-8k(x) then a/c-8k(x)");
    expect(tokens.map((token) => token.slug)).toEqual(["a/b-8k", "a/c-8k"]);
  });

  it("returns empty for empty/list-free text (the empty-guard input)", () => {
    expect(extractModelTokens("")).toEqual([]);
    expect(extractModelTokens("429 Rate limit exceeded. Try again later.")).toEqual([]);
  });
});
