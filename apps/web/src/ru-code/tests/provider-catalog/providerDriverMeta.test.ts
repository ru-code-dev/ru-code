import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DRIVER_OPTIONS,
  getDriverOption,
  PROVIDER_CLIENT_DEFINITIONS,
} from "../../../components/settings/providerDriverMeta";

describe("PROVIDER_CLIENT_DEFINITIONS", () => {
  it("ships qwen as the primary driver, listed first", () => {
    const first = PROVIDER_CLIENT_DEFINITIONS[0];
    expect(first?.value).toBe("qwen");
    // ru-code: the catalog label is the DEFAULT profile's name (Custom Code), matching
    // its icon — the kind stays `qwen`.
    expect(first?.label).toBe("Custom Code");
    // The add-provider dialog defaults to DRIVER_OPTIONS[0].
    expect(DRIVER_OPTIONS[0]?.value).toBe("qwen");
  });

  it("also ships opencode", () => {
    const opencode = PROVIDER_CLIENT_DEFINITIONS.find((def) => def.value === "opencode");
    expect(opencode?.label).toBe("OpenCode");
  });

  it("is limited to exactly qwen and opencode", () => {
    expect(PROVIDER_CLIENT_DEFINITIONS.map((def) => def.value)).toEqual(["qwen", "opencode"]);
  });

  it("omits the temporarily removed drivers", () => {
    const values = PROVIDER_CLIENT_DEFINITIONS.map((def) => def.value);
    for (const removed of ["codex", "claudeAgent", "cursor", "grok"] as const) {
      expect(values).not.toContain(removed);
    }
  });
});

describe("getDriverOption", () => {
  it("returns the qwen definition for the qwen driver kind", () => {
    const option = getDriverOption(ProviderDriverKind.make("qwen"));
    expect(option?.value).toBe("qwen");
    expect(option?.label).toBe("Custom Code"); // ru-code: default-profile name, not "Qwen"
  });

  it("returns undefined for a removed / unknown driver kind", () => {
    expect(getDriverOption(ProviderDriverKind.make("codex"))).toBeUndefined();
  });

  it("returns undefined when the driver is undefined", () => {
    expect(getDriverOption(undefined)).toBeUndefined();
  });
});
