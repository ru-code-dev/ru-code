import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSelectableProvider } from "../../../providerModels";

function provider(input: {
  driver: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveSelectableProvider", () => {
  it("returns the requested instance's driver when that instance is enabled", () => {
    const providers = [
      provider({ driver: ProviderDriverKind.make("qwen"), instanceId: "qwen" }),
      provider({ driver: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("opencode"))).toBe(
      "opencode",
    );
  });

  it("falls back to the first enabled provider when the requested instance is disabled", () => {
    const providers = [
      provider({ driver: ProviderDriverKind.make("qwen"), instanceId: "qwen" }),
      provider({
        driver: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        enabled: false,
      }),
    ];

    // A persisted `opencode` selection while opencode is disabled must resolve
    // to the first ENABLED provider rather than the disabled requested one.
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("opencode"))).toBe("qwen");
  });

  it("skips leading disabled providers and returns the first enabled driver", () => {
    const providers = [
      provider({
        driver: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        enabled: false,
      }),
      provider({ driver: ProviderDriverKind.make("qwen"), instanceId: "qwen" }),
    ];

    expect(resolveSelectableProvider(providers, undefined)).toBe("qwen");
  });

  it("defaults to the qwen driver kind when no provider is enabled", () => {
    const providers = [
      provider({
        driver: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        enabled: false,
      }),
    ];

    // DEFAULT_DRIVER_KIND is the ru-code primary driver: qwen.
    expect(resolveSelectableProvider(providers, undefined)).toBe("qwen");
  });

  it("defaults to the qwen driver kind for an empty provider list", () => {
    expect(resolveSelectableProvider([], undefined)).toBe("qwen");
  });
});
