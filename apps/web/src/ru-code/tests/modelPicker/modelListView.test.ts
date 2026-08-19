// ru-code: the model picker's LIST decision as a composite. Locks the real behaviour a
// user sees: a READY instance's discovered models appear as rows verbatim, a
// visible-but-NOT-ready instance still rails while its models are withheld (the break
// class where a healthy instance's list silently comes back empty), and the search
// query narrows the list exactly as the component does. These back the useMemos in
// ModelPickerContent, which now only renders what flatten/filter return.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelEsque } from "../../../components/chat/providerIconUtils";
import { providerModelKey } from "../../../modelOrdering";
import { type ProviderInstanceEntry } from "../../../providerInstances";
import { resolveModelPickerInstanceView } from "../../modelPicker/instanceView";
import {
  filterModelPickerModels,
  flattenModelPickerModels,
  type ModelPickerItem,
} from "../../modelPicker/modelListView";

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

function model(slug: string, name: string): ModelEsque {
  return { slug, name };
}

// ru-code: t3's legacy marker must survive the flatten (C-05-122) — without
// it the picker's legacy grouping would silently collapse into the main list.
describe("flattenModelPickerModels — isLegacy survives the flatten", () => {
  it("a model marked isLegacy on the source carries the marker onto the flat row", () => {
    const entries = [entry({ instanceId: "qwen", status: "ready" })];
    const rows = flattenModelPickerModels({
      modelOptionsByInstance: new Map([
        [
          ProviderInstanceId.make("qwen"),
          [
            { slug: "giga/coder-old", name: "Giga Coder (legacy)", isLegacy: true },
            { slug: "giga/coder-new", name: "Giga Coder" },
          ],
        ],
      ]),
      entryByInstanceId: new Map(
        entries.map((instanceEntry) => [instanceEntry.instanceId, instanceEntry]),
      ),
      readyInstanceIds: resolveModelPickerInstanceView({
        instanceEntries: entries,
        lockedProvider: null,
      }).readyInstanceIds,
    });
    expect(rows.find((row) => row.slug === "giga/coder-old")?.isLegacy).toBe(true);
    expect(rows.find((row) => row.slug === "giga/coder-new")?.isLegacy).toBeUndefined();
  });
});

/** Flatten exactly the way ModelPickerContent wires it: ready set from the REAL instance view. */
function flattenForEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): ModelPickerItem[] {
  const view = resolveModelPickerInstanceView({ instanceEntries: entries, lockedProvider: null });
  return flattenModelPickerModels({
    modelOptionsByInstance,
    entryByInstanceId: new Map(
      entries.map((instanceEntry) => [instanceEntry.instanceId, instanceEntry]),
    ),
    readyInstanceIds: view.readyInstanceIds,
  });
}

const qwenId = ProviderInstanceId.make("qwen");
const codexId = ProviderInstanceId.make("codex");

const discoveredQwenModels = [
  model("giga/coder-xl-256k", "Giga Coder XL 256K"),
  model("giga/chat-mini", "Giga Chat Mini"),
];

describe("flattenModelPickerModels — ready instance contributes its discovered models", () => {
  it("a READY qwen instance's discovered models appear as rows with names verbatim", () => {
    const entries = [entry({ instanceId: "qwen", status: "ready" })];
    const rows = flattenForEntries(entries, new Map([[qwenId, discoveredQwenModels]]));

    expect(rows.map((row) => row.slug)).toEqual(["giga/coder-xl-256k", "giga/chat-mini"]);
    expect(rows.map((row) => row.name)).toEqual(["Giga Coder XL 256K", "Giga Chat Mini"]);
    // Each row carries its owning instance so the list can render icon + name.
    expect(rows[0]).toMatchObject({
      instanceId: qwenId,
      driverKind: ProviderDriverKind.make("qwen"),
      instanceDisplayName: "qwen",
    });
  });

  it("a NOT-ready instance still rails but its models are WITHHELD (ready-set gate)", () => {
    const entries = [entry({ instanceId: "qwen", status: "error" })];
    const view = resolveModelPickerInstanceView({ instanceEntries: entries, lockedProvider: null });
    // The instance is still a rail button…
    expect(view.sidebarInstanceEntries.map((railEntry) => railEntry.instanceId)).toEqual([qwenId]);
    // …but contributes zero rows until it reconciles.
    expect(flattenForEntries(entries, new Map([[qwenId, discoveredQwenModels]]))).toEqual([]);
  });

  it("the SAME instance flipping to ready brings its list back (not silently empty)", () => {
    const options = new Map([[qwenId, discoveredQwenModels]]);
    expect(
      flattenForEntries([entry({ instanceId: "qwen", status: "error" })], options),
    ).toHaveLength(0);
    expect(
      flattenForEntries([entry({ instanceId: "qwen", status: "ready" })], options),
    ).toHaveLength(2);
  });

  it("models of an instance that disappeared from the entries are skipped as stale", () => {
    const entries = [entry({ instanceId: "codex" })];
    const rows = flattenForEntries(
      entries,
      new Map([
        [codexId, [model("gpt-5", "GPT-5")]],
        [qwenId, discoveredQwenModels], // no matching entry anymore
      ]),
    );
    expect(rows.map((row) => row.slug)).toEqual(["gpt-5"]);
  });
});

describe("filterModelPickerModels — what the list finally shows", () => {
  const entries = [entry({ instanceId: "qwen" }), entry({ instanceId: "codex" })];
  const flatModels = flattenForEntries(
    entries,
    new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
      [qwenId, discoveredQwenModels],
      [codexId, [model("gpt-5", "GPT-5")]],
    ]),
  );
  const noFavorites = new Set<string>();

  it("no search ⇒ only the rail-selected instance's models", () => {
    const shown = filterModelPickerModels({
      flatModels,
      searchQuery: "",
      favoriteModelKeys: noFavorites,
      lockedProvider: null,
      lockedContinuationGroupKey: null,
      selectedInstanceId: qwenId,
      instanceOrder: [qwenId, codexId],
    });
    expect(shown.map((row) => row.slug)).toEqual(["giga/coder-xl-256k", "giga/chat-mini"]);
  });

  it("search query filters across instances as the component does", () => {
    const shown = filterModelPickerModels({
      flatModels,
      searchQuery: "coder",
      favoriteModelKeys: noFavorites,
      lockedProvider: null,
      lockedContinuationGroupKey: null,
      selectedInstanceId: qwenId,
      instanceOrder: [qwenId, codexId],
    });
    expect(shown.map((row) => row.slug)).toEqual(["giga/coder-xl-256k"]);
  });

  it("search ignores the rail selection — a model of ANOTHER instance is still found", () => {
    const shown = filterModelPickerModels({
      flatModels,
      searchQuery: "gpt-5",
      favoriteModelKeys: noFavorites,
      lockedProvider: null,
      lockedContinuationGroupKey: null,
      selectedInstanceId: qwenId,
      instanceOrder: [qwenId, codexId],
    });
    expect(shown.map((row) => row.slug)).toEqual(["gpt-5"]);
  });

  it("searching under a LOCKED provider only surfaces the locked driver's models", () => {
    const shown = filterModelPickerModels({
      flatModels,
      searchQuery: "g", // prefix-matches BOTH "Giga …" and "GPT-5"
      favoriteModelKeys: noFavorites,
      lockedProvider: ProviderDriverKind.make("codex"),
      lockedContinuationGroupKey: null,
      selectedInstanceId: codexId,
      instanceOrder: [qwenId, codexId],
    });
    expect(shown.map((row) => row.slug)).toEqual(["gpt-5"]);
  });

  it("Favorites rail shows only favorited keys, ordered by instance order", () => {
    const favorites = new Set([
      providerModelKey(codexId, "gpt-5"),
      providerModelKey(qwenId, "giga/chat-mini"),
    ]);
    const shown = filterModelPickerModels({
      flatModels,
      searchQuery: "",
      favoriteModelKeys: favorites,
      lockedProvider: null,
      lockedContinuationGroupKey: null,
      selectedInstanceId: "favorites",
      instanceOrder: [qwenId, codexId],
    });
    expect(shown.map((row) => providerModelKey(row.instanceId, row.slug))).toEqual([
      providerModelKey(qwenId, "giga/chat-mini"),
      providerModelKey(codexId, "gpt-5"),
    ]);
  });
});

// ru-code: capacity gating — models the chat no longer fits into arrive from
// flatten pre-flagged (`disabledByContext`), and the exceptions are exact:
// the composer's active model, unknown-window models and fresh chats are
// NEVER gated.
describe("flattenModelPickerModels — disabledByContext capacity gate", () => {
  const windowedQwenModels: ReadonlyArray<ModelEsque> = [
    { slug: "giga/coder-xl-256k", name: "Giga Coder XL 256K", contextWindowTokens: 262_144 },
    { slug: "giga/chat-mini", name: "Giga Chat Mini", contextWindowTokens: 32_768 },
    { slug: "giga/mystery", name: "Giga Mystery" }, // no served window
  ];

  function flattenWithUsage(input: {
    readonly usedTokens: number | null;
    readonly activeModelSlug?: string;
  }): ReadonlyMap<string, ModelPickerItem> {
    const entries = [entry({ instanceId: "qwen", status: "ready" })];
    const rows = flattenModelPickerModels({
      modelOptionsByInstance: new Map([[qwenId, windowedQwenModels]]),
      entryByInstanceId: new Map(
        entries.map((instanceEntry) => [instanceEntry.instanceId, instanceEntry]),
      ),
      readyInstanceIds: resolveModelPickerInstanceView({
        instanceEntries: entries,
        lockedProvider: null,
      }).readyInstanceIds,
      usedTokens: input.usedTokens,
      activeInstanceId: qwenId,
      activeModelSlug: input.activeModelSlug ?? null,
    });
    return new Map(rows.map((row) => [row.slug, row] as const));
  }

  it("a model whose window is SMALLER than the usage is disabled", () => {
    const rows = flattenWithUsage({ usedTokens: 100_000 });
    expect(rows.get("giga/chat-mini")?.disabledByContext).toBe(true); // 32k < 100k
    expect(rows.get("giga/coder-xl-256k")?.disabledByContext).toBe(false); // 256k holds it
  });

  it("a window exactly EQUAL to the usage is NOT disabled", () => {
    const rows = flattenWithUsage({ usedTokens: 32_768 });
    expect(rows.get("giga/chat-mini")?.disabledByContext).toBe(false);
  });

  it("an unknown window is NEVER disabled (non-qwen providers serve none)", () => {
    const rows = flattenWithUsage({ usedTokens: 10_000_000 });
    expect(rows.get("giga/mystery")?.disabledByContext).toBe(false);
  });

  it("the ACTIVE model is never disabled even when it no longer fits", () => {
    const rows = flattenWithUsage({ usedTokens: 100_000, activeModelSlug: "giga/chat-mini" });
    expect(rows.get("giga/chat-mini")?.disabledByContext).toBe(false);
  });

  it("fresh chat (usedTokens null) disables NOTHING", () => {
    const rows = flattenWithUsage({ usedTokens: null });
    expect([...rows.values()].every((row) => !row.disabledByContext)).toBe(true);
  });

  it("without the gating inputs at all, nothing is disabled and the window still rides on the item", () => {
    const entries = [entry({ instanceId: "qwen", status: "ready" })];
    const rows = flattenForEntries(entries, new Map([[qwenId, windowedQwenModels]]));
    expect(rows.every((row) => !row.disabledByContext)).toBe(true);
    expect(rows.find((row) => row.slug === "giga/chat-mini")?.contextWindowTokens).toBe(32_768);
    expect(rows.find((row) => row.slug === "giga/mystery")?.contextWindowTokens).toBeUndefined();
  });
});
