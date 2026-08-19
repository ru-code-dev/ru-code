// ru-code: channel A transform — the exact `session/new` response shape qwen
// 0.13.1 sends (acpAgent.ts buildAvailableModels: modelId = `${id}(${authType})`,
// name = label, _meta.contextLimit = window) must land as store rows with the
// right slug/auth/window, and every degraded shape (no models, empty list,
// missing contextLimit, unparseable id) must degrade exactly as specified.
//
// Locked semantics: the SLUG is the single naming/window authority. The
// advertised `name` label is IGNORED (it's CLI-side config junk — the user's
// `modelProviders` display label or qwen's raw lowercase hardcoded id); the
// slug's size suffix takes PRIORITY over `_meta.contextLimit`.
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import { discoveredModelsFromSessionSetup } from "../../../qwen/discovery/discoveredModelsFromSessionSetup.ts";

const setupWithModels = (
  availableModels: ReadonlyArray<EffectAcpSchema.ModelInfo>,
): EffectAcpSchema.NewSessionResponse => ({
  sessionId: "session-1",
  models: { currentModelId: availableModels[0]?.modelId ?? "", availableModels },
});

describe("discoveredModelsFromSessionSetup", () => {
  it("maps the real qwen advertisement shape: names ALWAYS humanized from the slug, labels ignored", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        {
          // qwen's raw hardcoded lowercase id as label — must NOT surface.
          modelId: "flash-model(qwen-oauth)",
          name: "flash-model",
          description: "Qwen 3.5 Plus",
          _meta: { contextLimit: 1_000_000 },
        },
        {
          // user's ~/.qwen modelProviders display label — must NOT surface.
          modelId: "acme/coder-xl-256k(openai)",
          name: "LM Studio Qwen",
          _meta: { contextLimit: 256_000 },
        },
      ]),
    );
    expect(discovered).toEqual([
      // No size suffix in the slug → contextLimit is the window fallback.
      { slug: "flash-model", authMethod: "qwen-oauth", name: "Flash Model", nTokens: 1_000_000 },
      {
        slug: "acme/coder-xl-256k",
        authMethod: "openai",
        name: "Acme Coder Xl 256K",
        nTokens: 256_000,
      },
    ]);
  });

  it("slug size suffix takes PRIORITY over a conflicting _meta.contextLimit", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        { modelId: "acme/coder-xl-256k(openai)", name: "X", _meta: { contextLimit: 999 } },
      ]),
    );
    expect(discovered[0]?.nTokens).toBe(256_000);
  });

  it("uses contextLimit only when the slug has no size suffix; junk contextLimit degrades to absent", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        { modelId: "acme/plain(openai)", name: "A", _meta: { contextLimit: 128_000 } },
        { modelId: "acme/mini-32k(openai)", name: "B" }, // no _meta at all → suffix
        { modelId: "acme/med(openai)", name: "C", _meta: { contextLimit: 0 } },
        { modelId: "acme/big(openai)", name: "D", _meta: { contextLimit: "junk" } },
      ]),
    );
    expect(discovered.map((model) => model.nTokens)).toEqual([
      128_000,
      32_000,
      undefined,
      undefined,
    ]);
  });

  it("omits nTokens when neither a size suffix nor contextLimit exists", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([{ modelId: "plain-model(openai)", name: "Plain" }]),
    );
    expect(discovered).toEqual([
      { slug: "plain-model", authMethod: "openai", name: "Plain Model" },
    ]);
  });

  it("keeps an unparseable modelId as a raw slug with empty auth (never drops a model)", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([{ modelId: "weird id without auth", name: "" }]),
    );
    expect(discovered).toEqual([
      { slug: "weird id without auth", authMethod: "", name: "Weird id without auth" },
    ]);
  });

  it("dedupes advertised entries by slug (first wins)", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        { modelId: "dup-model(openai)", name: "First", _meta: { contextLimit: 100 } },
        { modelId: "dup-model(openai)", name: "Second", _meta: { contextLimit: 200 } },
      ]),
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual({
      slug: "dup-model",
      authMethod: "openai",
      name: "Dup Model",
      nTokens: 100,
    });
  });

  it("returns [] for responses without model state (the empty-guard input)", () => {
    expect(discoveredModelsFromSessionSetup({ sessionId: "s" })).toEqual([]);
    expect(discoveredModelsFromSessionSetup({ sessionId: "s", models: null })).toEqual([]);
    expect(discoveredModelsFromSessionSetup(setupWithModels([]))).toEqual([]);
  });
});

describe("discoveredModelsFromSessionSetup — the HIDE_MODELS scan gate", () => {
  it("drops an advertised model whose slug matches HIDE_MODELS ('er-model' ⊂ 'coder-model')", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        {
          // qwen's hardcoded builtin — HIDE_MODELS match, must never enter the app.
          modelId: "coder-model(qwen-oauth)",
          name: "coder-model",
          description: null,
          _meta: { contextLimit: 1_000_000 },
        },
        {
          modelId: "flash-model(qwen-oauth)",
          name: "flash-model",
          description: null,
          _meta: { contextLimit: 256_000 },
        },
      ]),
    );
    expect(discovered.map((model) => model.slug)).toEqual(["flash-model"]);
  });

  it("an advertisement of ONLY hidden models comes out empty (the caller's empty-guard keeps the current set)", () => {
    const discovered = discoveredModelsFromSessionSetup(
      setupWithModels([
        {
          modelId: "coder-model(qwen-oauth)",
          name: "coder-model",
          description: null,
          _meta: { contextLimit: 1_000_000 },
        },
      ]),
    );
    expect(discovered).toEqual([]);
  });
});
