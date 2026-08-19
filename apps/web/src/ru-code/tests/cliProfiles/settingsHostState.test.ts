// ru-code: the provider-card HOST decision — what a qwen instance's persisted `config`
// blob becomes when the user adds / removes / reorders a custom model or changes the
// session-start auth, plus the auth projection the per-model rows fall back to. These
// back ProviderInstanceCard.updateCustomModels / addCustomModelWithAuth /
// updateDefaultAuthMethod, which are now one-liners over this module. Locking the whole
// transition here guarantees the wiring (not just the leaf helpers) can't drift.
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CLI_PROFILE_ID } from "@ru-code/branding";

import {
  configAfterCustomModelAdd,
  configAfterCustomModelListChange,
  configAfterDefaultAuthMethodChange,
  resolveInstanceAuthProjection,
} from "../../cliProfiles/settingsHostState";

describe("configAfterCustomModelAdd — qwen add with auth", () => {
  it("appends { slug, authMethod }, preserving prior entries + other config keys", () => {
    const config = {
      profile: "qwen",
      binaryPath: "/x/cli.js",
      customModels: [{ slug: "a", authMethod: "openai" }],
    };
    expect(configAfterCustomModelAdd(config, "b", "qwen-oauth")).toEqual({
      profile: "qwen",
      binaryPath: "/x/cli.js",
      customModels: [
        { slug: "a", authMethod: "openai" },
        { slug: "b", authMethod: "qwen-oauth" },
      ],
    });
  });

  it("re-adding an existing slug UPDATES its auth instead of duplicating the row", () => {
    const config = { customModels: [{ slug: "a", authMethod: "openai" }] };
    expect(configAfterCustomModelAdd(config, "a", "qwen-oauth")).toEqual({
      customModels: [{ slug: "a", authMethod: "qwen-oauth" }],
    });
  });

  it("Auto ('') is stored verbatim so the server resolves it per model", () => {
    expect(configAfterCustomModelAdd({}, "a", "")).toEqual({
      customModels: [{ slug: "a", authMethod: "" }],
    });
  });
});

describe("configAfterCustomModelListChange — remove / reorder", () => {
  it("qwen: dropping a slug removes it but KEEPS survivors' auth methods", () => {
    const config = {
      customModels: [
        { slug: "a", authMethod: "openai" },
        { slug: "b", authMethod: "qwen-oauth" },
        { slug: "c", authMethod: "" },
      ],
    };
    // User removed "b"; the section hands back the surviving slugs.
    expect(configAfterCustomModelListChange(config, ["a", "c"], true)).toEqual({
      customModels: [
        { slug: "a", authMethod: "openai" },
        { slug: "c", authMethod: "" },
      ],
    });
  });

  it("qwen: reorder preserves each slug's stored auth (no auth is lost on move)", () => {
    const config = {
      customModels: [
        { slug: "a", authMethod: "openai" },
        { slug: "b", authMethod: "qwen-oauth" },
      ],
    };
    expect(configAfterCustomModelListChange(config, ["b", "a"], true)).toEqual({
      customModels: [
        { slug: "b", authMethod: "qwen-oauth" },
        { slug: "a", authMethod: "openai" },
      ],
    });
  });

  it("non-profile driver stores the plain slug[] shape (no auth objects)", () => {
    const config = { customModels: ["a", "b"] };
    expect(configAfterCustomModelListChange(config, ["b"], false)).toEqual({
      customModels: ["b"],
    });
  });
});

describe("configAfterDefaultAuthMethodChange — session-start default", () => {
  it("stores a concrete method", () => {
    expect(configAfterDefaultAuthMethodChange({ profile: "qwen" }, "openai")).toEqual({
      profile: "qwen",
      defaultAuthMethod: "openai",
    });
  });

  it("Auto ('') DELETES the key so the server falls back to the profile default", () => {
    expect(
      configAfterDefaultAuthMethodChange({ profile: "qwen", defaultAuthMethod: "openai" }, ""),
    ).toEqual({ profile: "qwen" });
  });
});

describe("resolveInstanceAuthProjection — profile + override ⇒ effective fallback", () => {
  it("no override ⇒ the profile default is the effective per-model fallback", () => {
    const projection = resolveInstanceAuthProjection({ profile: "qwen" });
    expect(projection.profileId).toBe("qwen");
    expect(projection.storedDefaultAuthMethod).toBe("");
    // qwen profile's default auth is qwen-oauth; Auto everywhere resolves to it.
    expect(projection.effectiveDefaultAuthMethod).toBe("qwen-oauth");
  });

  it("a stored override wins as the effective fallback (per-model 'Auto' matches it)", () => {
    const projection = resolveInstanceAuthProjection({
      profile: "qwen",
      defaultAuthMethod: "openai",
    });
    expect(projection.storedDefaultAuthMethod).toBe("openai");
    expect(projection.effectiveDefaultAuthMethod).toBe("openai");
  });

  it("an unset profile falls back to the single-source default profile", () => {
    expect(resolveInstanceAuthProjection({}).profileId).toBe(DEFAULT_CLI_PROFILE_ID);
  });
});
