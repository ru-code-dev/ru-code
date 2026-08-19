// ru-code: coverage for `deriveEffectiveComposerModelState` — the derivation
// the CHAT composer trigger/dispatch actually consume (the settings text-gen
// path has its own resolver + tests). The rule: persisted-if-served, else the
// FIRST served model, and with 0 served models the state must stay "" —
// CLI-defaults mode («Default model», no --model on the wire). Fixtures
// mirror resolveAppModelSelectionState.test.ts.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveEffectiveComposerModelState } from "../../../composerDraftStore";

const QWEN_INSTANCE = ProviderInstanceId.make("qwen");
const FIRST_SERVED = "team/alpha-coder-256k";
const SECOND_SERVED = "team/beta-coder";

function qwenProvider(models: ReadonlyArray<string>): ServerProvider {
  return {
    instanceId: QWEN_INSTANCE,
    driver: ProviderDriverKind.make("qwen"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

const selection = (model: string): ModelSelection =>
  ({ instanceId: QWEN_INSTANCE, model }) as ModelSelection;

function derive(input: { models: ReadonlyArray<string>; threadModel: string | null }): string {
  return deriveEffectiveComposerModelState({
    draft: null,
    providers: [qwenProvider(input.models)],
    selectedProvider: ProviderDriverKind.make("qwen"),
    selectedInstanceId: QWEN_INSTANCE,
    threadModelSelection: input.threadModel === null ? null : selection(input.threadModel),
    projectModelSelection: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  }).selectedModel;
}

describe("deriveEffectiveComposerModelState — qwen live default resolution", () => {
  it("persisted model that is served is honored", () => {
    expect(derive({ models: [FIRST_SERVED, SECOND_SERVED], threadModel: SECOND_SERVED })).toBe(
      SECOND_SERVED,
    );
  });

  it("persisted model no longer served falls back to the FIRST served model", () => {
    expect(derive({ models: [FIRST_SERVED, SECOND_SERVED], threadModel: "deleted/ghost" })).toBe(
      FIRST_SERVED,
    );
  });

  it("no persisted model resolves to the FIRST served model", () => {
    expect(derive({ models: [FIRST_SERVED, SECOND_SERVED], threadModel: null })).toBe(FIRST_SERVED);
  });

  it("0 served models must stay empty — CLI-defaults mode, never a phantom slug", () => {
    // A phantom here surfaces in the trigger AND dispatches over the wire
    // (setModel with a model qwen does not serve).
    expect(derive({ models: [], threadModel: "" })).toBe("");
  });

  it("0 served models with no selection at all must also stay empty", () => {
    expect(derive({ models: [], threadModel: null })).toBe("");
  });
});
