// ru-code: channel B decision — both proven -32603 details shapes must trigger
// the right mutation, and everything else must return null (a discovery false
// positive silently corrupts the model list). The qwen-local string is verbatim
// from qwen 0.13.1 modelsConfig.ts:383-387; the backend shapes mirror the openai
// SDK envelope `"<status> <body.error.message>"` with suggestion prose.
import { describe, expect, it } from "vite-plus/test";

import { detectModelErrorDiscovery } from "../../../qwen/discovery/modelErrorDiscovery.ts";

describe("detectModelErrorDiscovery — qwen-local registry miss", () => {
  it("names the dead model from the verbatim qwen string", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "Model 'giga/dead-32k' not found for authType 'openai'",
      sentModelSlug: "giga/dead-32k",
    });
    expect(discovery).toEqual({ badModelSlug: "giga/dead-32k", suggestedModels: [] });
  });

  it("works even when sentModelSlug is unknown (the string itself names it)", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "Model 'ghost' not found for authType 'qwen-oauth'",
      sentModelSlug: null,
    });
    expect(discovery?.badModelSlug).toBe("ghost");
  });
});

describe("detectModelErrorDiscovery — backend prose", () => {
  it("drops the sent model and extracts the suggestion list (phrase + tokens)", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText:
        "404 Model not found. Available models: giga/coder-xl-256k(openai), giga/mini-32k(openai)",
      sentModelSlug: "giga/dead-64k",
    });
    expect(discovery?.badModelSlug).toBe("giga/dead-64k");
    expect(discovery?.suggestedModels).toEqual([
      {
        slug: "giga/coder-xl-256k",
        authMethod: "openai",
        name: "Giga Coder Xl 256K",
        nTokens: 256_000,
      },
      { slug: "giga/mini-32k", authMethod: "openai", name: "Giga Mini 32K", nTokens: 32_000 },
    ]);
  });

  it("accepts a ≥2-token list even without a not-found phrase (near 'model')", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Please pick a model: giga/a-8k(openai) giga/b-8k(openai)",
      sentModelSlug: "giga/dead-8k",
    });
    expect(discovery?.suggestedModels).toHaveLength(2);
  });

  it("never lists the dead model among the suggestions", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Model not found. Try giga/dead-8k(openai) or giga/alive-8k(openai)",
      sentModelSlug: "giga/dead-8k",
    });
    expect(discovery?.suggestedModels.map((model) => model.slug)).toEqual(["giga/alive-8k"]);
  });

  it("phrase without tokens still drops the sent model (remove-bad only)", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "404 The model `giga/dead-8k` does not exist or you do not have access to it.",
      sentModelSlug: "giga/dead-8k",
    });
    expect(discovery).toEqual({ badModelSlug: "giga/dead-8k", suggestedModels: [] });
  });

  it("recognizes Russian backend prose", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Модель не найдена. Доступные модели: giga/coder-128k(openai)",
      sentModelSlug: "giga/dead-8k",
    });
    expect(discovery?.suggestedModels.map((model) => model.slug)).toEqual(["giga/coder-128k"]);
  });
});

describe("detectModelErrorDiscovery — false-positive guards", () => {
  it("rejects errors that never mention models", () => {
    expect(
      detectModelErrorDiscovery({
        detailsText: "429 Rate limit exceeded. Try again later.",
        sentModelSlug: "giga/current-8k",
      }),
    ).toBeNull();
    expect(
      detectModelErrorDiscovery({
        detailsText: "Model stream ended with empty response text.",
        sentModelSlug: "giga/current-8k",
      }),
    ).toBeNull();
  });

  it("rejects a single echoed token without a not-found phrase", () => {
    expect(
      detectModelErrorDiscovery({
        detailsText: "500 model giga/current-8k(openai) crashed while decoding",
        sentModelSlug: "giga/current-8k",
      }),
    ).toBeNull();
  });

  it("rejects phrase-only prose when nothing can be dropped or added", () => {
    expect(
      detectModelErrorDiscovery({
        detailsText: "404 model not found",
        sentModelSlug: null,
      }),
    ).toBeNull();
  });
});
