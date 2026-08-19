import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OpenAI } from "../../../components/Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "../../../components/chat/providerIconUtils";

describe("PROVIDER_ICON_BY_PROVIDER", () => {
  it("resolves the qwen driver to the OpenAI icon mark", () => {
    // ru-code: qwen uses OpenAI-compatible auth and reuses the OpenAI mark.
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("qwen")]).toBe(OpenAI);
  });
});
