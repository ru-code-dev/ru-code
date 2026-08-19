// ru-code: the model picker's instance-visibility decision as a composite. Locks the
// real behaviour a user sees: which instances become rail buttons, which contribute
// models, how a LOCKED provider (message-edit / continuation) reorders + disables the
// rail, and which rail item is primed on open. These back the useMemos in
// ModelPickerContent, which now only renders what resolveModelPickerInstanceView returns.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ProviderInstanceEntry } from "../../../providerInstances";
import {
  matchesLockedProvider,
  resolveInitialModelPickerInstance,
  resolveModelPickerInstanceView,
} from "../../modelPicker/instanceView";

function entry(input: {
  readonly instanceId: string;
  readonly driverKind?: string;
  readonly enabled?: boolean;
  readonly isAvailable?: boolean;
  readonly status?: ServerProvider["status"];
  readonly continuationGroupKey?: string;
}): ProviderInstanceEntry {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const driverKind = ProviderDriverKind.make(input.driverKind ?? input.instanceId);
  return {
    instanceId,
    driverKind,
    displayName: input.instanceId,
    enabled: input.enabled ?? true,
    installed: true,
    status: input.status ?? "ready",
    isDefault: true,
    isAvailable: input.isAvailable ?? true,
    ...(input.continuationGroupKey ? { continuationGroupKey: input.continuationGroupKey } : {}),
    snapshot: {} as ServerProvider,
    models: [],
  };
}

const ids = (entries: ReadonlyArray<ProviderInstanceEntry>) => entries.map((e) => e.instanceId);

describe("resolveModelPickerInstanceView — unlocked", () => {
  it("rail shows only ENABLED instances; disabled ones are dropped from the rail", () => {
    const entries = [
      entry({ instanceId: "codex", enabled: true }),
      entry({ instanceId: "qwen", enabled: false }),
      entry({ instanceId: "claude", enabled: true }),
    ];
    const view = resolveModelPickerInstanceView({ instanceEntries: entries, lockedProvider: null });
    expect(ids(view.sidebarInstanceEntries)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claude"),
    ]);
    // Nothing is locked, so no instance is marked disabled in the rail.
    expect(view.disabledInstanceIds).toBeUndefined();
  });

  it("only enabled+available+ready instances may contribute models", () => {
    const entries = [
      entry({ instanceId: "ready", enabled: true, isAvailable: true, status: "ready" }),
      entry({ instanceId: "disabled", enabled: false, isAvailable: true, status: "ready" }),
      entry({ instanceId: "unavailable", enabled: true, isAvailable: false, status: "ready" }),
      entry({ instanceId: "notReady", enabled: true, isAvailable: true, status: "error" }),
    ];
    const view = resolveModelPickerInstanceView({ instanceEntries: entries, lockedProvider: null });
    expect([...view.readyInstanceIds]).toEqual([ProviderInstanceId.make("ready")]);
  });

  it("a visible-but-not-ready instance still rails but withholds its models", () => {
    const entries = [entry({ instanceId: "warming", enabled: true, status: "warning" })];
    const view = resolveModelPickerInstanceView({ instanceEntries: entries, lockedProvider: null });
    expect(ids(view.sidebarInstanceEntries)).toEqual([ProviderInstanceId.make("warming")]);
    expect(view.readyInstanceIds.size).toBe(0);
  });
});

describe("resolveModelPickerInstanceView — locked provider (message-edit / continuation)", () => {
  it("keeps matching instances selectable, orders them first, and disables the rest", () => {
    const codex = ProviderDriverKind.make("codex");
    const entries = [
      entry({ instanceId: "qwen", driverKind: "qwen", enabled: true }),
      entry({ instanceId: "codex", driverKind: "codex", enabled: true }),
      entry({ instanceId: "codex_personal", driverKind: "codex", enabled: true }),
    ];
    const view = resolveModelPickerInstanceView({
      instanceEntries: entries,
      lockedProvider: codex,
    });
    // Both codex instances stay selectable and sort BEFORE the disabled qwen.
    expect(ids(view.sidebarInstanceEntries)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("codex_personal"),
      ProviderInstanceId.make("qwen"),
    ]);
    // Only the non-matching qwen is disabled.
    expect([...(view.disabledInstanceIds ?? [])]).toEqual([ProviderInstanceId.make("qwen")]);
  });

  it("a continuation group narrows the lock to the same lineage", () => {
    const codex = ProviderDriverKind.make("codex");
    const entries = [
      entry({ instanceId: "codex", driverKind: "codex", continuationGroupKey: "group-a" }),
      entry({ instanceId: "codex_other", driverKind: "codex", continuationGroupKey: "group-b" }),
    ];
    const view = resolveModelPickerInstanceView({
      instanceEntries: entries,
      lockedProvider: codex,
      lockedContinuationGroupKey: "group-a",
    });
    // Same kind but the wrong continuation lineage is disabled.
    expect([...(view.disabledInstanceIds ?? [])]).toEqual([ProviderInstanceId.make("codex_other")]);
    expect(ids(view.sidebarInstanceEntries)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("codex_other"),
    ]);
  });
});

describe("matchesLockedProvider", () => {
  const codex = ProviderDriverKind.make("codex");
  const codexEntry = { driverKind: codex, continuationGroupKey: "g1" } as const;

  it("null lock matches every entry", () => {
    expect(matchesLockedProvider(codexEntry, null)).toBe(true);
  });
  it("kind mismatch never matches", () => {
    expect(matchesLockedProvider(codexEntry, ProviderDriverKind.make("qwen"))).toBe(false);
  });
  it("kind match with no continuation key matches regardless of lineage", () => {
    expect(matchesLockedProvider(codexEntry, codex)).toBe(true);
  });
  it("continuation key must also match when required", () => {
    expect(matchesLockedProvider(codexEntry, codex, "g1")).toBe(true);
    expect(matchesLockedProvider(codexEntry, codex, "g2")).toBe(false);
  });
});

describe("resolveInitialModelPickerInstance — primed rail item on open", () => {
  const active = ProviderInstanceId.make("codex");
  const codex = ProviderDriverKind.make("codex");

  it("locked ⇒ the active instance stays focused (never Favorites)", () => {
    expect(
      resolveInitialModelPickerInstance({
        lockedProvider: codex,
        activeInstanceId: active,
        hasFavorites: true,
      }),
    ).toBe(active);
  });
  it("unlocked with favorites ⇒ Favorites rail", () => {
    expect(
      resolveInitialModelPickerInstance({
        lockedProvider: null,
        activeInstanceId: active,
        hasFavorites: true,
      }),
    ).toBe("favorites");
  });
  it("unlocked without favorites ⇒ the active instance", () => {
    expect(
      resolveInitialModelPickerInstance({
        lockedProvider: null,
        activeInstanceId: active,
        hasFavorites: false,
      }),
    ).toBe(active);
  });
});
