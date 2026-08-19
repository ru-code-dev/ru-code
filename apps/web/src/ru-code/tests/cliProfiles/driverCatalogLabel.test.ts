// ru-code: the add-provider catalog entry for the qwen driver must display the
// DEFAULT profile's name + mark (Custom Code), so the label matches its icon and
// reflects what a new instance becomes by default. Kind stays `qwen`.
import { DEFAULT_CLI_PROFILE_ID, resolveCliProfile } from "@ru-code/branding";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTION_BY_VALUE } from "../../../components/settings/providerDriverMeta";
import { iconForProfile } from "../../cliProfiles/icons";

describe("driver catalog label (qwen)", () => {
  const qwen = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("qwen")];

  it("labels the qwen driver with the default profile's name (Custom Code), not 'Qwen'", () => {
    expect(qwen).toBeDefined();
    expect(qwen?.label).toBe(resolveCliProfile(DEFAULT_CLI_PROFILE_ID).name);
    expect(qwen?.label).toBe("Custom Code");
  });

  it("uses the default profile's icon so label + glyph agree", () => {
    expect(qwen?.icon).toBe(iconForProfile(DEFAULT_CLI_PROFILE_ID));
  });
});
