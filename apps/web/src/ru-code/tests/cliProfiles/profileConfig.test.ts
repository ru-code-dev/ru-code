// ru-code: pure coverage for the web-side profile-config helpers — reading/writing
// the brand profile on a provider instance's opaque config blob and gating on the
// qwen kind. These drive the add-dialog draft and the provider-card selector/title.
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CLI_PROFILE_ID } from "@ru-code/branding";

import {
  effectiveDefaultAuthMethod,
  isCliProfileDriver,
  rawProfileId,
  readProfile,
  readProfileId,
  writeProfile,
} from "../../cliProfiles/profileConfig";

describe("profileConfig — read/write brand profile on a config blob", () => {
  it("readProfileId returns the stored profile id", () => {
    expect(readProfileId({ profile: "qwen" })).toBe("qwen");
    expect(readProfileId({ profile: "custom" })).toBe("custom");
  });

  it("readProfileId defaults for missing / unknown / non-object config", () => {
    expect(readProfileId({})).toBe(DEFAULT_CLI_PROFILE_ID);
    expect(readProfileId({ profile: "bogus" })).toBe(DEFAULT_CLI_PROFILE_ID);
    expect(readProfileId(null)).toBe(DEFAULT_CLI_PROFILE_ID);
    expect(readProfileId(undefined)).toBe(DEFAULT_CLI_PROFILE_ID);
  });

  it("readProfile resolves the display data (name / artifact / description)", () => {
    const p = readProfile({ profile: "qwen" });
    expect(p.name).toBe("Qwen Code");
    expect(p.artifact).toBe("QWEN");
    expect(p.description.length).toBeGreaterThan(0);
  });

  it("writeProfile sets profile without dropping other config keys", () => {
    const next = writeProfile({ binaryPath: "/x/cli.js", homePath: "~/h" }, "qwen");
    expect(next).toEqual({ binaryPath: "/x/cli.js", homePath: "~/h", profile: "qwen" });
    // a non-object config becomes a fresh blob carrying just the profile
    expect(writeProfile(null, "custom")).toEqual({ profile: "custom" });
  });

  it("round-trips: writeProfile then readProfileId", () => {
    expect(readProfileId(writeProfile({}, "qwen"))).toBe("qwen");
    expect(readProfileId(writeProfile({ profile: "qwen" }, "custom"))).toBe("custom");
  });

  it("isCliProfileDriver only matches the qwen kind", () => {
    expect(isCliProfileDriver("qwen")).toBe(true);
    expect(isCliProfileDriver("opencode")).toBe(false);
    expect(isCliProfileDriver(undefined)).toBe(false);
    expect(isCliProfileDriver("custom")).toBe(false); // "custom" is a profile, not a kind
  });
});

describe("effectiveDefaultAuthMethod — override ?? profile default (mirrors server)", () => {
  it("falls back to the profile default when no override is stored", () => {
    expect(effectiveDefaultAuthMethod({ profile: "custom" })).toBe("openai");
    expect(effectiveDefaultAuthMethod({ profile: "qwen" })).toBe("qwen-oauth");
    expect(effectiveDefaultAuthMethod({})).toBe("openai"); // default profile is custom
  });

  it("a valid stored override wins over the profile default", () => {
    expect(effectiveDefaultAuthMethod({ profile: "qwen", defaultAuthMethod: "openai" })).toBe(
      "openai",
    );
    expect(effectiveDefaultAuthMethod({ profile: "custom", defaultAuthMethod: "anthropic" })).toBe(
      "anthropic",
    );
  });

  it("an unknown/blank override is ignored (profile default wins)", () => {
    expect(effectiveDefaultAuthMethod({ profile: "qwen", defaultAuthMethod: "bogus" })).toBe(
      "qwen-oauth",
    );
    expect(effectiveDefaultAuthMethod({ profile: "qwen", defaultAuthMethod: "" })).toBe(
      "qwen-oauth",
    );
  });
});

describe("rawProfileId + add-wizard default", () => {
  it("rawProfileId returns the stored id, or undefined when unset/invalid (no defaulting)", () => {
    expect(rawProfileId({ profile: "qwen" })).toBe("qwen");
    expect(rawProfileId({ profile: "custom" })).toBe("custom");
    expect(rawProfileId({})).toBeUndefined();
    expect(rawProfileId({ profile: "bogus" })).toBeUndefined();
    expect(rawProfileId(null)).toBeUndefined();
  });

  it("a NEW instance defaults to the single-source default profile; an explicit pick wins", () => {
    // ru-code: the add wizard now uses DEFAULT_CLI_PROFILE_ID (custom) — the same
    // constant the built-in instance uses. No separate add-only default.
    expect(DEFAULT_CLI_PROFILE_ID).toBe("custom");
    // untouched wizard draft → created config carries the default profile
    const created = writeProfile({}, rawProfileId({}) ?? DEFAULT_CLI_PROFILE_ID);
    expect(created.profile).toBe("custom");
    // an explicit dropdown choice overrides the default
    const draft = { profile: "qwen" };
    const explicit = writeProfile(draft, rawProfileId(draft) ?? DEFAULT_CLI_PROFILE_ID);
    expect(explicit.profile).toBe("qwen");
  });
});
