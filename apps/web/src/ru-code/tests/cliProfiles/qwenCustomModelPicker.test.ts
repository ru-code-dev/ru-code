// ru-code: GAP-1 fix at the web boundary — a custom model added to a qwen instance
// (stored as qwen's `{ slug, authMethod }` object shape) must surface as a SELECTABLE
// option in the chat model picker. `getAppModelOptionsForInstance` reads the instance
// config via `readInstanceCustomModels`, which now normalizes both the object shape
// (qwen) and the plain-slug shape (other drivers). Before the fix the object entries
// were filtered out and the model was unselectable; this test fails on that regression.
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getAppModelOptionsForInstance } from "../../../modelSelection";
import type { ProviderInstanceEntry } from "../../../providerInstances";

const QWEN = ProviderDriverKind.make("qwen");
const INSTANCE = ProviderInstanceId.make("qwen");

const settingsWithCustomModels = (customModels: unknown): UnifiedSettings =>
  ({
    providerInstances: {
      [INSTANCE]: { driver: QWEN, config: { profile: "qwen", customModels } },
    },
  }) as unknown as UnifiedSettings;

// The picker only reads instanceId / driverKind / models off the entry; cast the
// rest (snapshot etc.) since it is irrelevant to custom-model surfacing.
const entry = (models: ProviderInstanceEntry["models"] = []): ProviderInstanceEntry =>
  ({ instanceId: INSTANCE, driverKind: QWEN, models }) as unknown as ProviderInstanceEntry;

describe("qwen custom models reach the chat picker", () => {
  it("surfaces an object-shape { slug, authMethod } custom model as a selectable option", () => {
    const options = getAppModelOptionsForInstance(
      settingsWithCustomModels([{ slug: "my-model", authMethod: "anthropic" }]),
      entry(),
    );
    const custom = options.find((option) => option.slug === "my-model");
    expect(custom).toBeDefined();
    expect(custom?.isCustom).toBe(true);
  });

  it("still surfaces multiple object-shape custom models alongside built-ins", () => {
    const options = getAppModelOptionsForInstance(
      settingsWithCustomModels([
        { slug: "m1", authMethod: "openai" },
        { slug: "m2", authMethod: "qwen-oauth" },
      ]),
      entry([{ slug: "builtin", name: "Built In", isCustom: false, capabilities: null }]),
    );
    expect(options.map((option) => option.slug)).toEqual(
      expect.arrayContaining(["builtin", "m1", "m2"]),
    );
  });

  it("remains backward-compatible with the plain-slug string shape", () => {
    const options = getAppModelOptionsForInstance(
      settingsWithCustomModels(["legacy-slug"]),
      entry(),
    );
    expect(options.some((option) => option.slug === "legacy-slug")).toBe(true);
  });
});
