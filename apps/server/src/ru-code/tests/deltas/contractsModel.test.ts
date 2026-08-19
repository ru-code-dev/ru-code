// ru-code: coverage for our qwen deltas in `model.ts` — the display-name entry
// plus the DELIBERATE ABSENCE of qwen entries in the two model-default maps.
// A hardcoded default slug goes stale over time and would resurrect as a
// phantom model through the getDefaultServerModel fallback chain; qwen's
// default is resolved live (first served model) instead.
import { QWEN_KIND } from "@ru-code/branding";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
} from "@t3tools/contracts";

const QWEN_DRIVER_KIND = ProviderDriverKind.make(QWEN_KIND);

describe("model.ts — ru-code qwen deltas", () => {
  it("PROVIDER_DISPLAY_NAMES has the qwen display name", () => {
    expect(PROVIDER_DISPLAY_NAMES[QWEN_DRIVER_KIND]).toBe("Qwen");
  });

  it("DEFAULT_MODEL_BY_PROVIDER has NO qwen entry (no phantom default slug)", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[QWEN_DRIVER_KIND]).toBeUndefined();
  });

  it("DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER has NO qwen entry (no phantom default slug)", () => {
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[QWEN_DRIVER_KIND]).toBeUndefined();
  });
});
