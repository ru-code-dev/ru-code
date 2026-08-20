// ru-code: guards the reactor's restart decision — specifically that a skill/agent change
// (`catalogChanged`) forces a --acp session respawn, and can never be silently dropped from the OR.

import { assert, describe, it } from "@effect/vitest";

import {
  shouldRestartProviderSession,
  type ProviderRestartFlags,
} from "../../skills-agents/respawnDecision.ts";

const NONE: ProviderRestartFlags = {
  runtimeModeChanged: false,
  cwdChanged: false,
  instanceChanged: false,
  shouldRestartForModelChange: false,
  shouldRestartForModelSelectionChange: false,
  catalogChanged: false,
  overlayChanged: false,
};

describe("shouldRestartProviderSession", () => {
  it("does NOT restart when nothing changed (session is resumed in place)", () => {
    assert.strictEqual(shouldRestartProviderSession(NONE), false);
  });

  it("RESTARTS on a catalog change alone — a skill/agent add/remove/sync respawns qwen", () => {
    assert.strictEqual(shouldRestartProviderSession({ ...NONE, catalogChanged: true }), true);
  });

  it("each dimension independently forces a restart", () => {
    for (const key of Object.keys(NONE) as Array<keyof ProviderRestartFlags>) {
      assert.strictEqual(
        shouldRestartProviderSession({ ...NONE, [key]: true }),
        true,
        `expected restart when ${key} is set`,
      );
    }
  });
});
