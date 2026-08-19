// ru-code: THE serving rule — profile built-ins until the first discovery, then
// discovered-only, custom always appended (deduped by slug). A regression here
// changes what the picker offers on every qwen thread, so the whole decision is
// asserted (not fragments): source switching, auth fallback, window derivation.
import { describe, expect, it } from "vite-plus/test";
import { QwenSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  resolveServedModelAuthMethod,
  serveQwenModels,
} from "../../../qwen/discovery/serveQwenModels.ts";
import { resolveModelAuthMethod } from "../../../qwen/profileResolver.ts";
import { resolveQwenModelContextWindow } from "../../../qwen/discovery/resolveQwenModelContextWindow.ts";
import { CONTEXT_WINDOW_TOKENS } from "@ru-code/qwen/constants";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);

const settingsWith = (overrides: Record<string, unknown> = {}) =>
  decodeQwenSettings({ profile: "custom", ...overrides });

describe("serveQwenModels — source switching", () => {
  it("serves profile built-ins (with profile-owned windows) before any discovery", () => {
    const served = serveQwenModels(settingsWith(), []);
    expect(served.map((model) => model.slug)).toEqual([
      "qwen/qwen3.6-35b-a3b",
      "qwen3-coder-flash",
    ]);
    expect(served.every((model) => model.nTokens === 252_000)).toBe(true);
    expect(served.every((model) => !model.isCustom)).toBe(true);
  });

  it("replaces profile built-ins wholesale once ≥1 model is discovered", () => {
    const served = serveQwenModels(settingsWith(), [
      { slug: "acme/coder-xl-256k", authMethod: "openai", name: "Acme Coder", nTokens: 256_000 },
    ]);
    expect(served.map((model) => model.slug)).toEqual(["acme/coder-xl-256k"]);
    expect(served[0]?.nTokens).toBe(256_000);
    expect(served[0]?.authType).toBe("openai");
  });

  it("appends custom models to BOTH sources, parsing their slug window", () => {
    const customSettings = settingsWith({
      customModels: [{ slug: "my/custom-64k", authMethod: "openai" }],
    });
    const beforeDiscovery = serveQwenModels(customSettings, []);
    expect(beforeDiscovery.map((model) => model.slug)).toEqual([
      "qwen/qwen3.6-35b-a3b",
      "qwen3-coder-flash",
      "my/custom-64k",
    ]);
    expect(beforeDiscovery[2]).toMatchObject({ isCustom: true, nTokens: 64_000 });

    const afterDiscovery = serveQwenModels(customSettings, [
      { slug: "acme/a-8k", authMethod: "openai", name: "A", nTokens: 8_000 },
    ]);
    expect(afterDiscovery.map((model) => model.slug)).toEqual(["acme/a-8k", "my/custom-64k"]);
  });

  it("dedupes by slug — a discovered entry wins over the same custom slug", () => {
    const served = serveQwenModels(
      settingsWith({ customModels: [{ slug: "acme/a-8k", authMethod: "" }] }),
      [{ slug: "acme/a-8k", authMethod: "openai", name: "A", nTokens: 9_000 }],
    );
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ isCustom: false, nTokens: 9_000 });
  });

  it("resolves unknown/blank discovered auth to the instance default", () => {
    const served = serveQwenModels(settingsWith(), [
      { slug: "acme/a-8k", authMethod: "", name: "A" },
      { slug: "acme/b-8k", authMethod: "not-a-method", name: "B" },
    ]);
    // custom profile's defaultAuthMethod is "openai".
    expect(served.map((model) => model.authType)).toEqual(["openai", "openai"]);
  });

  it("omits nTokens for discovered models with no window data", () => {
    const served = serveQwenModels(settingsWith(), [
      { slug: "plain-model", authMethod: "openai", name: "Plain" },
    ]);
    expect(served[0]?.nTokens).toBeUndefined();
  });
});

describe("resolveQwenModelContextWindow — the meter denominator chain", () => {
  const discovered = [
    { slug: "acme/coder-xl-256k", authMethod: "openai", name: "Acme", nTokens: 256_000 },
    { slug: "plain-model", authMethod: "openai", name: "Plain" },
  ] as const;

  it("served entry's nTokens wins", () => {
    expect(
      resolveQwenModelContextWindow(settingsWith(), [...discovered], "acme/coder-xl-256k"),
    ).toBe(256_000);
    // Profile model before discovery → profile-owned window.
    expect(resolveQwenModelContextWindow(settingsWith(), [], "qwen3-coder-flash")).toBe(252_000);
  });

  it("falls back to the slug's size suffix for unserved models", () => {
    expect(resolveQwenModelContextWindow(settingsWith(), [], "unlisted/model-128k")).toBe(128_000);
  });

  it("falls back to CONTEXT_WINDOW_TOKENS when nothing is derivable", () => {
    expect(resolveQwenModelContextWindow(settingsWith(), [...discovered], "plain-model")).toBe(
      CONTEXT_WINDOW_TOKENS,
    );
    expect(resolveQwenModelContextWindow(settingsWith(), [], undefined)).toBe(
      CONTEXT_WINDOW_TOKENS,
    );
    expect(resolveQwenModelContextWindow(settingsWith(), [], "")).toBe(CONTEXT_WINDOW_TOKENS);
  });
});

describe("resolveServedModelAuthMethod", () => {
  const settings = decodeQwenSettings({});

  it("the served entry's own auth wins (discovered model)", () => {
    const served = serveQwenModels(settings, [
      { slug: "coder-model", name: "coder-model", authMethod: "qwen-oauth" },
    ]);
    expect(resolveServedModelAuthMethod(settings, served, "coder-model")).toBe("qwen-oauth");
  });

  it("a slug absent from the served list falls back to the settings resolution", () => {
    expect(resolveServedModelAuthMethod(settings, [], "unknown/model")).toBe(
      resolveModelAuthMethod(settings, "unknown/model"),
    );
  });
});

describe("serveQwenModels — HIDE_MODELS and the manual-add exception", () => {
  it("a USER custom model whose slug matches HIDE_MODELS still serves (adding it manually is deliberate)", () => {
    // The scan gate lives in the discovery functions, NOT here: customModels are not a
    // scan, so a hidden slug the user typed into provider settings must keep working.
    const settings = settingsWith({
      customModels: [{ slug: "coder-model", authMethod: "qwen-oauth" }],
    });
    const served = serveQwenModels(settings, []);
    const customServed = served.find((model) => model.slug === "coder-model");
    expect(customServed).toBeDefined();
    expect(customServed!.isCustom).toBe(true);
    // The scan gate dropped the advertisement that carried this model's window, so the
    // HIDE_MODELS entry's KNOWN window fills in — the meter denominator stays correct.
    expect(customServed!.nTokens).toBe(1_000_000);
    expect(resolveQwenModelContextWindow(settings, [], "coder-model")).toBe(1_000_000);
  });

  it("a hidden custom slug WITH a size suffix keeps the suffix window (suffix wins over the known window)", () => {
    const settings = settingsWith({
      customModels: [{ slug: "acme/coder-model-256k", authMethod: "openai" }],
    });
    const served = serveQwenModels(settings, []);
    expect(served.find((model) => model.slug === "acme/coder-model-256k")!.nTokens).toBe(256_000);
  });

  it("a non-hidden suffix-less custom slug still has NO window (unchanged default-meter behavior)", () => {
    const settings = settingsWith({
      customModels: [{ slug: "acme/plain", authMethod: "openai" }],
    });
    const served = serveQwenModels(settings, []);
    expect(served.find((model) => model.slug === "acme/plain")!.nTokens).toBeUndefined();
  });
});
