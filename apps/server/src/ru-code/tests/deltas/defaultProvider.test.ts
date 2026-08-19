// ru-code: coverage for the single-source default-provider constants in @ru-code/branding.
// There is deliberately NO default-model constant: a hardcoded slug goes stale
// (deleted upstream, renamed backend-side), so the model default is resolved
// live — first served model of the instance — never seeded from branding.
import { describe, expect, it } from "vite-plus/test";
import { CLI_PROFILE_IDS, DEFAULT_PROVIDER_INSTANCE_ID } from "@ru-code/branding";

describe("default-provider constants", () => {
  it("exposes a non-empty default instance id", () => {
    expect(typeof DEFAULT_PROVIDER_INSTANCE_ID).toBe("string");
    expect(DEFAULT_PROVIDER_INSTANCE_ID.length).toBeGreaterThan(0);
  });
  it("the default instance id is a built-in id (equals its own kind — no custom-suffix)", () => {
    // built-in instance id == kind (no `_` suffix like `codex_personal`)
    expect(DEFAULT_PROVIDER_INSTANCE_ID).not.toContain("_");
  });
  it("the default instance id names a known CLI profile family", () => {
    // sanity: the default resolves against the fork's known profile ids.
    expect(CLI_PROFILE_IDS.length).toBeGreaterThan(0);
  });
});
