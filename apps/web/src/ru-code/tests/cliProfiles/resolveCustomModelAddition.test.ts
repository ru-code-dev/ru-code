// ru-code: the whole "add a custom model" decision — parse inline `slug(auth)` →
// normalize → validate → decide commit shape. Tested as one composite so the
// wiring (not just the parse fragment) is guaranteed: a qwen result carries the
// auth to commit; a non-qwen result is a plain slug; every rejection returns its
// message. ProviderModelsSection.handleAdd is a thin dispatcher over this.
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MAX_CUSTOM_MODEL_LENGTH } from "../../../modelSelection";
import { resolveCustomModelAddition } from "../../cliProfiles/resolveCustomModelAddition";

const QWEN = ProviderDriverKind.make("qwen");
const OPENCODE = ProviderDriverKind.make("opencode");

const model = (slug: string, isCustom = false): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});

const BUILT_INS: ReadonlyArray<ServerProviderModel> = [model("qwen3-coder-plus")];

describe("resolveCustomModelAddition — qwen (auth on)", () => {
  const base = {
    driverKind: QWEN,
    models: BUILT_INS,
    customModels: ["already-saved"] as ReadonlyArray<string>,
    authFallback: "qwen-oauth" as const,
  };

  it("commits a clean slug with the dropdown's chosen auth", () => {
    expect(
      resolveCustomModelAddition({ ...base, raw: "my-model", authMethodInput: "anthropic" }),
    ).toEqual({ ok: true, slug: "my-model", authMethod: "anthropic" });
  });

  it("commits Auto ('') when the dropdown is left on Auto", () => {
    expect(resolveCustomModelAddition({ ...base, raw: "my-model", authMethodInput: "" })).toEqual({
      ok: true,
      slug: "my-model",
      authMethod: "",
    });
  });

  it("peels an inline slug(auth) suffix — clean slug stored, parsed auth wins over the dropdown", () => {
    expect(
      resolveCustomModelAddition({
        ...base,
        raw: "my-model(openai)",
        authMethodInput: "anthropic",
      }),
    ).toEqual({ ok: true, slug: "my-model", authMethod: "openai" });
  });

  it("leaves an unknown inline suffix literal (does not mangle a real slug)", () => {
    expect(
      resolveCustomModelAddition({ ...base, raw: "my-model(bogus)", authMethodInput: "" }),
    ).toEqual({ ok: true, slug: "my-model(bogus)", authMethod: "" });
  });

  it("rejects an empty slug", () => {
    const result = resolveCustomModelAddition({ ...base, raw: "   ", authMethodInput: "" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "Enter a model slug." });
  });

  it("rejects a slug that duplicates a built-in model", () => {
    const result = resolveCustomModelAddition({
      ...base,
      raw: "qwen3-coder-plus",
      authMethodInput: "",
    });
    expect(result).toEqual({ ok: false, error: "That model is already built in." });
  });

  it("rejects a slug already saved as custom", () => {
    const result = resolveCustomModelAddition({
      ...base,
      raw: "already-saved",
      authMethodInput: "",
    });
    expect(result).toEqual({ ok: false, error: "That custom model is already saved." });
  });

  it("rejects an over-long slug", () => {
    const tooLong = "x".repeat(MAX_CUSTOM_MODEL_LENGTH + 1);
    const result = resolveCustomModelAddition({ ...base, raw: tooLong, authMethodInput: "" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
    });
  });

  it("dedups against a built-in AFTER peeling the inline auth suffix", () => {
    // `qwen3-coder-plus(openai)` normalizes to the built-in slug → still rejected.
    const result = resolveCustomModelAddition({
      ...base,
      raw: "qwen3-coder-plus(openai)",
      authMethodInput: "",
    });
    expect(result).toEqual({ ok: false, error: "That model is already built in." });
  });
});

describe("resolveCustomModelAddition — non-qwen (auth off)", () => {
  const base = {
    driverKind: OPENCODE,
    models: [] as ReadonlyArray<ServerProviderModel>,
    customModels: [] as ReadonlyArray<string>,
  };

  it("returns a plain slug with NO authMethod (caller appends via onChange)", () => {
    const result = resolveCustomModelAddition({ ...base, raw: "openai/gpt-5" });
    expect(result).toEqual({ ok: true, slug: "openai/gpt-5" });
    // no authMethod key at all
    expect(result.ok && "authMethod" in result).toBe(false);
  });

  it("does NOT peel a `(…)` suffix for non-qwen drivers (it may be a real slug part)", () => {
    const result = resolveCustomModelAddition({ ...base, raw: "weird(openai)" });
    expect(result).toEqual({ ok: true, slug: "weird(openai)" });
  });

  it("still rejects an empty slug", () => {
    const result = resolveCustomModelAddition({ ...base, raw: "" });
    expect(result).toEqual({ ok: false, error: "Enter a model slug." });
  });
});
