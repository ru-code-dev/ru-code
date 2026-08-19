// ru-code: control for the "coder-model comes back after I hide it" report —
// pins that the WEB option-assembly layer honors `providerModelPreferences`
// across discovery-driven snapshot refreshes (the served array is a NEW object
// after every refresh; hiding must survive that). If these pass, the picker
// layer is exonerated and the regression lives upstream of it (the discovery
// store rewrite ripple / dispatch fallback), which the server-side pins cover.
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { getAppModelOptionsForInstance } from "../../../modelSelection";

const INSTANCE = ProviderInstanceId.make("qwen");

const servedModels = () => [
  // Discovery order: qwen advertises its built-in oauth model FIRST.
  { slug: "coder-model", name: "Coder", isCustom: false, capabilities: null, nTokens: 1_000_000 },
  {
    slug: "qwen/qwen3.6-35b-a3b",
    name: "Mine",
    isCustom: false,
    capabilities: null,
    nTokens: 262_144,
  },
];

const entryWith = (models: ReturnType<typeof servedModels>) =>
  ({
    instanceId: INSTANCE,
    driverKind: ProviderDriverKind.make("qwen"),
    models,
  }) as never;

const settingsWithHidden = (hiddenModels: ReadonlyArray<string>): UnifiedSettings =>
  ({
    providers: {},
    providerInstances: {},
    providerModelPreferences: {
      [INSTANCE]: { hiddenModels, modelOrder: [] },
    },
  }) as never;

describe("hidden models survive discovery refreshes (picker assembly)", () => {
  it("a hidden discovered model is excluded from the options", () => {
    const options = getAppModelOptionsForInstance(
      settingsWithHidden(["coder-model"]),
      entryWith(servedModels()),
    );
    expect(options.map((option) => option.slug)).not.toContain("coder-model");
    expect(options.map((option) => option.slug)).toContain("qwen/qwen3.6-35b-a3b");
  });

  it("stays excluded when the served list is a fresh array after a snapshot refresh", () => {
    const settings = settingsWithHidden(["coder-model"]);
    const before = getAppModelOptionsForInstance(settings, entryWith(servedModels()));
    // Discovery re-advertisement → snapshot refresh → NEW served array object.
    const after = getAppModelOptionsForInstance(settings, entryWith(servedModels()));
    expect(before.map((option) => option.slug)).toEqual(after.map((option) => option.slug));
    expect(after.map((option) => option.slug)).not.toContain("coder-model");
  });

  it("no preferences ⇒ the discovered order serves as-is (coder-model first)", () => {
    const options = getAppModelOptionsForInstance(
      settingsWithHidden([]),
      entryWith(servedModels()),
    );
    expect(options[0]?.slug).toBe("coder-model");
  });
});
