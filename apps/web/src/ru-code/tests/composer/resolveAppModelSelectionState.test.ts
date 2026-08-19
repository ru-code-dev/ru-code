// ru-code: coverage for `resolveAppModelSelectionState` — the text-gen selection resolver/heal.
// Asserts (a) no stored selection resolves to the single-source default, (b) a disabled stored
// instance heals to the first enabled provider, and (c) the resolve is idempotent (proves the §7a
// write-back effect cannot loop). Fixtures mirror the shapes in `apps/web/src/modelSelection.test.ts`.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { DEFAULT_PROVIDER_INSTANCE_ID } from "@ru-code/branding";
import { describe, expect, it } from "vite-plus/test";
import { resolveAppModelSelectionState } from "../../../modelSelection";

// Arbitrary served slugs — there is no seeded default-model constant anymore;
// the resolver must land on the instance's FIRST served model.
const FIRST_SERVED = "team/alpha-coder-256k";
const SECOND_SERVED = "team/beta-coder";

function makeProvider(
  instanceId: string,
  models: ReadonlyArray<string>,
  enabled: boolean,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled,
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

const enabledProvider = (instanceId: string, models: ReadonlyArray<string>): ServerProvider =>
  makeProvider(instanceId, models, true);
const disabledProvider = (instanceId: string, models: ReadonlyArray<string>): ServerProvider =>
  makeProvider(instanceId, models, false);

function settingsWith(
  selection: { instanceId: string; model: string } | undefined,
): UnifiedSettings {
  // Setting textGenerationModelSelection to `undefined` exercises the "no stored selection" branch;
  // the field is required on the decoded type, so the cast is load-bearing here.
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerationModelSelection: selection
      ? {
          instanceId: ProviderInstanceId.make(selection.instanceId),
          model: selection.model,
        }
      : undefined,
  } as unknown as UnifiedSettings;
}

describe("resolveAppModelSelectionState — default + heal", () => {
  it("no stored selection → default instance's FIRST served model", () => {
    const providers = [
      enabledProvider(DEFAULT_PROVIDER_INSTANCE_ID, [FIRST_SERVED, SECOND_SERVED]),
    ];
    const out = resolveAppModelSelectionState(settingsWith(undefined), providers);
    expect(out.instanceId).toBe(DEFAULT_PROVIDER_INSTANCE_ID);
    expect(out.model).toBe(FIRST_SERVED);
  });

  it("stored model not in the served list → resolves to the FIRST served model (displayed == used)", () => {
    const providers = [
      enabledProvider(DEFAULT_PROVIDER_INSTANCE_ID, [FIRST_SERVED, SECOND_SERVED]),
    ];
    const out = resolveAppModelSelectionState(
      settingsWith({ instanceId: DEFAULT_PROVIDER_INSTANCE_ID, model: "deleted/ghost-model" }),
      providers,
    );
    expect(out.model).toBe(FIRST_SERVED);
  });

  it("stored model IS served → honored verbatim (user intent wins over first-served)", () => {
    const providers = [
      enabledProvider(DEFAULT_PROVIDER_INSTANCE_ID, [FIRST_SERVED, SECOND_SERVED]),
    ];
    const out = resolveAppModelSelectionState(
      settingsWith({ instanceId: DEFAULT_PROVIDER_INSTANCE_ID, model: SECOND_SERVED }),
      providers,
    );
    expect(out.model).toBe(SECOND_SERVED);
  });

  it("0 served models → model resolves to '' (CLI-defaults mode, no phantom slug)", () => {
    const providers = [enabledProvider(DEFAULT_PROVIDER_INSTANCE_ID, [])];
    const out = resolveAppModelSelectionState(settingsWith(undefined), providers);
    expect(out.instanceId).toBe(DEFAULT_PROVIDER_INSTANCE_ID);
    expect(out.model).toBe("");
  });

  it("stored points at a DISABLED instance → heals to the first enabled (safety net)", () => {
    const providers = [disabledProvider("codex", []), enabledProvider("opencode", ["m1"])];
    const out = resolveAppModelSelectionState(
      settingsWith({ instanceId: "codex", model: "x" }),
      providers,
    );
    expect(out.instanceId).toBe("opencode");
  });

  it("is IDEMPOTENT — resolving an already-resolved selection returns the same (no write loop)", () => {
    const providers = [
      enabledProvider(DEFAULT_PROVIDER_INSTANCE_ID, [FIRST_SERVED, SECOND_SERVED]),
    ];
    const once = resolveAppModelSelectionState(settingsWith(undefined), providers);
    const twice = resolveAppModelSelectionState(
      settingsWith({ instanceId: once.instanceId, model: once.model }),
      providers,
    );
    expect(twice.instanceId).toBe(once.instanceId);
    expect(twice.model).toBe(once.model);
  });
});
