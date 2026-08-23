import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CLI_PROFILE_ID } from "@ru-code/branding";
import { iconForProfile } from "../../cliProfiles/icons";
import { OpenAI } from "../../../components/Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "../../../components/chat/providerIconUtils";

describe("PROVIDER_ICON_BY_PROVIDER", () => {
  // ru-code: profile-less qwen (e.g. the update toast, which never carries a
  // profile) must wear its own brand mark, not a competitor's (OpenAI).
  it("resolves the qwen driver to the default-profile mark, not OpenAI", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("qwen")]).toBe(
      iconForProfile(DEFAULT_CLI_PROFILE_ID),
    );
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("qwen")]).not.toBe(OpenAI);
  });
});
