// ru-code: coverage for our additive deltas in `settings.ts`:
//  - `QwenSettings` provider schema decodes a representative input,
//  - the DEFAULT provider config has qwen `enabled === true` while every other
//    provider (codex/claude/cursor/grok/opencode) defaults `enabled === false`,
//  - the default text-generation provider resolves to the qwen instance.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_SERVER_SETTINGS, QwenSettings } from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INSTANCE_ID } from "@ru-code/branding";

const decodeQwenSettings = Schema.decodeUnknownSync(QwenSettings);

describe("QwenSettings — ru-code provider schema delta", () => {
  it("decodes a representative input", () => {
    const decoded = decodeQwenSettings({
      enabled: true,
      binaryPath: "qwen",
      homePath: "~/.qwen",
      launchArgs: "--verbose",
      defaultAuthMethod: "qwen-oauth",
      // ru-code: custom models are now { slug, authMethod } objects, not slug strings.
      customModels: [{ slug: "my-model", authMethod: "openai" }],
    });
    expect(decoded.enabled).toBe(true);
    expect(decoded.binaryPath).toBe("qwen");
    expect(decoded.homePath).toBe("~/.qwen");
    expect(decoded.launchArgs).toBe("--verbose");
    expect(decoded.defaultAuthMethod).toBe("qwen-oauth");
    expect(decoded.customModels).toEqual([{ slug: "my-model", authMethod: "openai" }]);
  });

  it("defaults `enabled` true, `profile` custom, and overrides empty on an empty object", () => {
    const decoded = decodeQwenSettings({});
    expect(decoded.enabled).toBe(true);
    // ru-code: profile defaults to the fork ("custom"); the boot instance uses it.
    expect(decoded.profile).toBe("custom");
    // ru-code: binaryPath/homePath default EMPTY (not the "qwen" fallback) so the
    // profile resolver can tell "unset" (⇒ profile/preflight default) from a path.
    expect(decoded.binaryPath).toBe("");
    expect(decoded.homePath).toBe("");
    // ru-code: defaultAuthMethod defaults empty (⇒ resolve from profile on the server);
    // customModels defaults to an empty array.
    expect(decoded.defaultAuthMethod).toBe("");
    expect(decoded.customModels).toEqual([]);
  });
});

describe("Default provider enablement — ru-code delta", () => {
  const providers = DEFAULT_SERVER_SETTINGS.providers;

  it("qwen is enabled by default", () => {
    expect(providers.qwen.enabled).toBe(true);
  });

  it("every other provider is disabled by default", () => {
    expect(providers.codex.enabled).toBe(false);
    expect(providers.claudeAgent.enabled).toBe(false);
    expect(providers.cursor.enabled).toBe(false);
    expect(providers.grok.enabled).toBe(false);
    expect(providers.opencode.enabled).toBe(false);
  });
});

describe("Default text-generation provider — ru-code delta", () => {
  it("resolves to the qwen instance", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId).toBe("qwen");
  });

  it("textGenerationModelSelection defaults to an unseeded (empty) model — resolver owns the default", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId).toBe(
      DEFAULT_PROVIDER_INSTANCE_ID,
    );
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model).toBe("");
  });
});
