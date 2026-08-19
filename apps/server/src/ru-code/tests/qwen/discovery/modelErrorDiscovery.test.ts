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
      detailsText: "Model 'acme/dead-32k' not found for authType 'openai'",
      sentModelSlug: "acme/dead-32k",
    });
    expect(discovery).toEqual({ badModelSlug: "acme/dead-32k", suggestedModels: [] });
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
        "404 Model not found. Available models: acme/coder-xl-256k(openai), acme/mini-32k(openai)",
      sentModelSlug: "acme/dead-64k",
    });
    expect(discovery?.badModelSlug).toBe("acme/dead-64k");
    expect(discovery?.suggestedModels).toEqual([
      {
        slug: "acme/coder-xl-256k",
        authMethod: "openai",
        name: "Acme Coder Xl 256K",
        nTokens: 256_000,
      },
      { slug: "acme/mini-32k", authMethod: "openai", name: "Acme Mini 32K", nTokens: 32_000 },
    ]);
  });

  it("accepts a ≥2-token list even without a not-found phrase (near 'model')", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Please pick a model: acme/a-8k(openai) acme/b-8k(openai)",
      sentModelSlug: "acme/dead-8k",
    });
    expect(discovery?.suggestedModels).toHaveLength(2);
  });

  it("never lists the dead model among the suggestions", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Model not found. Try acme/dead-8k(openai) or acme/alive-8k(openai)",
      sentModelSlug: "acme/dead-8k",
    });
    expect(discovery?.suggestedModels.map((model) => model.slug)).toEqual(["acme/alive-8k"]);
  });

  it("phrase without tokens still drops the sent model (remove-bad only)", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "404 The model `acme/dead-8k` does not exist or you do not have access to it.",
      sentModelSlug: "acme/dead-8k",
    });
    expect(discovery).toEqual({ badModelSlug: "acme/dead-8k", suggestedModels: [] });
  });

  it("recognizes Russian backend prose", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText: "400 Модель не найдена. Доступные модели: acme/coder-128k(openai)",
      sentModelSlug: "acme/dead-8k",
    });
    expect(discovery?.suggestedModels.map((model) => model.slug)).toEqual(["acme/coder-128k"]);
  });
});

describe("detectModelErrorDiscovery — false-positive guards", () => {
  it("rejects errors that never mention models", () => {
    expect(
      detectModelErrorDiscovery({
        detailsText: "429 Rate limit exceeded. Try again later.",
        sentModelSlug: "acme/current-8k",
      }),
    ).toBeNull();
    expect(
      detectModelErrorDiscovery({
        detailsText: "Model stream ended with empty response text.",
        sentModelSlug: "acme/current-8k",
      }),
    ).toBeNull();
  });

  it("rejects a single echoed token without a not-found phrase", () => {
    expect(
      detectModelErrorDiscovery({
        detailsText: "500 model acme/current-8k(openai) crashed while decoding",
        sentModelSlug: "acme/current-8k",
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

describe("detectModelErrorDiscovery — the HIDE_MODELS scan gate", () => {
  it("a backend-suggested model matching HIDE_MODELS never enters the suggestions", () => {
    const discovery = detectModelErrorDiscovery({
      detailsText:
        "404 Model not found. Available models: coder-model(qwen-oauth), acme/fresh-128k(openai)",
      sentModelSlug: "acme/dead-32k",
    });
    expect(discovery).not.toBeNull();
    expect(discovery!.suggestedModels.map((model) => model.slug)).toEqual(["acme/fresh-128k"]);
  });
});
