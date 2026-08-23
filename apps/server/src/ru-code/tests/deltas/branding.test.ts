// ru-code: coverage for the CLI branding — the single provider kind (`QWEN_KIND`),
// the preflight detection dir, and the profile registry (Custom Code fork vs stock
// Qwen Code) that supplies each instance's name/artifact/bin-dir defaults.
import { describe, expect, it } from "vite-plus/test";
import {
  AUTH_METHODS,
  AUTH_METHOD_IDS,
  asAuthMethodId,
  CONTEXT_COMPACTION_TASK_PREFIX,
  CONTEXT_COMPACTION_TASK_TYPE,
  PREFLIGHT_CLI_PROBE_DIRNAME,
  QWEN_KIND,
  CLI_PROFILES,
  CLI_PROFILE_IDS,
  DEFAULT_CLI_PROFILE_ID,
  resolveCliProfile,
} from "@ru-code/branding";

describe("@ru-code/branding — CLI kind + config dir", () => {
  it("QWEN_KIND is the single persisted provider kind, qwen", () => {
    expect(QWEN_KIND).toBe("qwen");
  });

  it("PREFLIGHT_CLI_PROBE_DIRNAME is the .qwen preflight probe dir", () => {
    expect(PREFLIGHT_CLI_PROBE_DIRNAME).toBe(".qwen");
  });
});

describe("@ru-code/branding — context-compaction wire identifiers", () => {
  it("the taskId prefix is the persisted `context-compaction:` literal", () => {
    expect(CONTEXT_COMPACTION_TASK_PREFIX).toBe("context-compaction:");
  });

  it("the taskType is `context_compaction` — the literal INERT_TASK_TYPES lists", () => {
    expect(CONTEXT_COMPACTION_TASK_TYPE).toBe("context_compaction");
  });

  it("prefix and taskType are distinct identifiers (one keys rows, one classifies them)", () => {
    // A single constant cannot serve both: the prefix must match `taskId.startsWith`,
    // the taskType must be an exact member of a classification set.
    expect(CONTEXT_COMPACTION_TASK_TYPE.startsWith(CONTEXT_COMPACTION_TASK_PREFIX)).toBe(false);
  });
});

describe("@ru-code/branding — CLI profile registry", () => {
  it("exposes exactly the custom + qwen profiles, default custom", () => {
    expect(CLI_PROFILE_IDS).toEqual(["custom", "qwen"]);
    expect(DEFAULT_CLI_PROFILE_ID).toBe("custom");
  });

  it("custom profile: Custom Code / CUSTOM_CODE, bin+dir default to preflight (null)", () => {
    const p = CLI_PROFILES.custom;
    expect(p.name).toBe("Custom Code");
    expect(p.artifact).toBe("CUSTOM_CODE");
    expect(p.binDefault).toBeNull();
    expect(p.dirDefault).toBeNull();
    expect(p.description.length).toBeGreaterThan(0);
  });

  it("qwen profile: Qwen Code / QWEN, `qwen` command + ~/.qwen defaults", () => {
    const p = CLI_PROFILES.qwen;
    expect(p.name).toBe("Qwen Code");
    expect(p.artifact).toBe("QWEN");
    expect(p.binDefault).toBe("qwen");
    expect(p.dirDefault).toBe("~/.qwen");
  });

  it("custom ships built-in models (valid auth ids); stock qwen ships none", () => {
    // Model-agnostic invariants — the custom fork bundles ready-to-use models; stock qwen
    // ships none (the user adds their own). Do NOT pin the specific slugs/auth: the model
    // list is product config that changes, not a contract to assert against.
    expect(CLI_PROFILES.custom.models.length).toBeGreaterThan(0);
    for (const model of CLI_PROFILES.custom.models) {
      expect(model.slug.length).toBeGreaterThan(0);
      expect(AUTH_METHOD_IDS).toContain(model.authMethod); // whatever the model, a KNOWN auth id
    }
    expect(CLI_PROFILES.qwen.models).toEqual([]);
  });

  it("default auth method: custom → openai, stock qwen → qwen-oauth", () => {
    expect(CLI_PROFILES.custom.defaultAuthMethod).toBe("openai");
    expect(CLI_PROFILES.qwen.defaultAuthMethod).toBe("qwen-oauth");
  });

  it("every profile's id matches its registry key", () => {
    for (const id of CLI_PROFILE_IDS) {
      expect(CLI_PROFILES[id].id).toBe(id);
    }
  });
});

describe("resolveCliProfile — narrow untrusted id", () => {
  it("returns the named profile", () => {
    expect(resolveCliProfile("qwen").id).toBe("qwen");
    expect(resolveCliProfile("custom").id).toBe("custom");
  });
  it("falls back to the default profile for unknown / null / undefined", () => {
    expect(resolveCliProfile("bogus").id).toBe(DEFAULT_CLI_PROFILE_ID);
    expect(resolveCliProfile(null).id).toBe(DEFAULT_CLI_PROFILE_ID);
    expect(resolveCliProfile(undefined).id).toBe(DEFAULT_CLI_PROFILE_ID);
  });
});

describe("auth methods — the five qwen AuthTypes", () => {
  it("AUTH_METHOD_IDS derives from AUTH_METHODS (one source of truth)", () => {
    expect(AUTH_METHOD_IDS).toEqual(AUTH_METHODS.map((m) => m.id));
    expect(AUTH_METHOD_IDS).toEqual(["openai", "qwen-oauth", "gemini", "vertex-ai", "anthropic"]);
  });

  it("every method has a non-empty human label", () => {
    expect(AUTH_METHODS.every((m) => m.label.length > 0)).toBe(true);
  });

  it("asAuthMethodId narrows known ids and rejects unknown/blank/nullish", () => {
    expect(asAuthMethodId("openai")).toBe("openai");
    expect(asAuthMethodId("qwen-oauth")).toBe("qwen-oauth");
    expect(asAuthMethodId("bogus")).toBeUndefined();
    expect(asAuthMethodId("")).toBeUndefined();
    expect(asAuthMethodId(null)).toBeUndefined();
    expect(asAuthMethodId(undefined)).toBeUndefined();
  });
});
