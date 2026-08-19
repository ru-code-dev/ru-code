// ru-code: fork coverage for `resolveProviderDriverKindForInstanceSelection`'s
// disabled-instance fallback (the ru-code seam in ../providerInstances.ts). Lives
// here (not in the port's providerInstances.test.ts) per the fork-isolation rules:
// new coverage of port code goes in a ru-code zone and imports the port function.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
} from "../../../providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveProviderDriverKindForInstanceSelection (ru-code disabled fallback)", () => {
  it("falls back to the first enabled kind when the selection matches a disabled instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("qwen"), instanceId: "qwen" }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    // A persisted `codex` default while codex is disabled must not pin the
    // composer to codex — it resolves to the first enabled kind instead.
    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("codex"),
      ),
    ).toBe("qwen");
  });

  it("returns the matched instance's own kind when that instance is enabled", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("qwen"), instanceId: "qwen" }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    // An enabled match must return its OWN kind, not just the first enabled
    // entry — selecting the second (enabled) instance keeps its driver kind.
    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("opencode"),
      ),
    ).toBe("opencode");
  });

  it("null/unknown selection → first enabled kind (safety net; never a hardcoded default)", () => {
    const providers = [provider({ provider: ProviderDriverKind.make("qwen"), instanceId: "qwen" })];
    const entries = deriveProviderInstanceEntries(providers);

    expect(resolveProviderDriverKindForInstanceSelection(entries, providers, null)).toBe("qwen");
  });

  it("returns undefined for a null selection only when nothing is enabled", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("qwen"), instanceId: "qwen", enabled: false }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(resolveProviderDriverKindForInstanceSelection(entries, providers, null)).toBeUndefined();
  });

  it("falls back to the matched disabled kind as a last resort when no instance is enabled", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("qwen"), instanceId: "qwen", enabled: false }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    // Every instance is disabled, so there is no enabled kind to fall back to;
    // the matched (disabled) instance's own kind is used as the last resort.
    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("codex"),
      ),
    ).toBe("codex");
  });
});
