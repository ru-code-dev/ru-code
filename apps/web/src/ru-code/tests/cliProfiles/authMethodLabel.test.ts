// ru-code: the auth-method label maps a stored value to human text, and renders the
// "Auto" sentinel with the method Auto RESOLVES TO in the caller's context
// (`fallbackAuthMethod`) — the profile default on the card, the effective instance
// default per model — so the hint never lies. Shared by the card row + the per-model
// dropdown, so pin the mapping here.
import { describe, expect, it } from "vite-plus/test";

import { AUTO_AUTH_METHOD, authMethodLabel } from "../../cliProfiles/CliAuthMethodSelect";

describe("authMethodLabel", () => {
  it("maps a known auth id to its human label (fallback ignored)", () => {
    expect(authMethodLabel("openai", "qwen-oauth")).toBe("OpenAI API");
    expect(authMethodLabel("qwen-oauth", "openai")).toBe("Qwen OAuth");
    expect(authMethodLabel("anthropic", "openai")).toBe("Anthropic");
  });

  it("renders the Auto sentinel with the given fallback as the hint", () => {
    expect(authMethodLabel(AUTO_AUTH_METHOD, "openai")).toBe("Auto (OpenAI API)");
    expect(authMethodLabel(AUTO_AUTH_METHOD, "qwen-oauth")).toBe("Auto (Qwen OAuth)");
    expect(authMethodLabel(AUTO_AUTH_METHOD, "anthropic")).toBe("Auto (Anthropic)");
  });
});
