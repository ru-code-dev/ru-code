// ru-code: proves the ghost fix end-to-end at both merge sites.
//
// qwen snapshots are AUTHORITATIVE (the full current model set from settings +
// profile), so a model removed from the new snapshot must vanish — both in the
// live registry merge (mergeProviderSnapshot) and in the boot-time cache hydrate
// (hydrateCachedProvider, which reads the on-disk status cache that otherwise
// makes ghosts survive restart). Every OTHER driver keeps its additive
// keep-absent merge, since those discover models incrementally.
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { QWEN_KIND } from "@ru-code/branding";
import { describe, expect, it } from "vite-plus/test";

import { mergeProviderSnapshot } from "../../../provider/Layers/ProviderRegistry.ts";
import { hydrateCachedProvider } from "../../../provider/providerStatusCache.ts";

const QWEN = ProviderDriverKind.make(QWEN_KIND);
const OPENCODE = ProviderDriverKind.make("opencode");
const withCaps = createModelCapabilities({
  optionDescriptors: [{ id: "thinking", type: "boolean", label: "Thinking" }],
});

const model = (slug: string, overrides?: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const makeProvider = (
  driver: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(driver),
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
  ...overrides,
});

const slugs = (provider: ServerProvider): ReadonlyArray<string> =>
  provider.models.map((entry) => entry.slug);

describe("mergeProviderSnapshot — authoritative (qwen) live merge", () => {
  it("drops a model absent from the new qwen snapshot (removed → gone, no ghost)", () => {
    const previous = makeProvider(QWEN, [model("a"), model("b")]);
    const next = makeProvider(QWEN, [model("a")]);
    expect(slugs(mergeProviderSnapshot(previous, next))).toEqual(["a"]);
  });

  it("adds a new model from the qwen snapshot", () => {
    const previous = makeProvider(QWEN, [model("a")]);
    const next = makeProvider(QWEN, [model("a"), model("c")]);
    expect(slugs(mergeProviderSnapshot(previous, next))).toEqual(["a", "c"]);
  });

  it("still preserves capabilities for a surviving qwen slug the new snapshot left bare", () => {
    const previous = makeProvider(QWEN, [model("a", { capabilities: withCaps })]);
    const next = makeProvider(QWEN, [model("a", { capabilities: null })]);
    const merged = mergeProviderSnapshot(previous, next);
    expect(merged.models[0]?.capabilities).toBe(withCaps);
  });

  it("keeps the previous set when the new qwen snapshot is empty (probe/error, not a real clear)", () => {
    const previous = makeProvider(QWEN, [model("a"), model("b")]);
    const next = makeProvider(QWEN, []);
    expect(slugs(mergeProviderSnapshot(previous, next))).toEqual(["a", "b"]);
  });
});

describe("mergeProviderSnapshot — additive (non-qwen) merge is unchanged", () => {
  it("keeps a model absent from a still-probing snapshot", () => {
    const previous = makeProvider(OPENCODE, [model("a"), model("b")]);
    const next = makeProvider(OPENCODE, [model("a")], { installed: false, status: "warning" });
    expect([...slugs(mergeProviderSnapshot(previous, next))].sort()).toEqual(["a", "b"]);
  });

  it("returns the new snapshot verbatim when there is no previous", () => {
    const next = makeProvider(QWEN, [model("a")]);
    expect(mergeProviderSnapshot(undefined, next)).toBe(next);
  });
});

describe("hydrateCachedProvider — authoritative (qwen) boot hydrate", () => {
  it("drops cached ghost models so a prior cache file can't resurrect them on restart", () => {
    const fallback = makeProvider(QWEN, [model("a")]);
    const cached = makeProvider(QWEN, [model("a"), model("stale-b"), model("old-profile-c")], {
      version: "9.9.9",
      status: "warning",
    });
    const hydrated = hydrateCachedProvider({ cachedProvider: cached, fallbackProvider: fallback });
    // models come wholesale from the fresh fallback — no cached carry-over…
    expect(slugs(hydrated)).toEqual(["a"]);
    // …but the other cached status fields still hydrate as before.
    expect(hydrated.version).toBe("9.9.9");
    expect(hydrated.status).toBe("warning");
  });
});

describe("hydrateCachedProvider — additive (non-qwen) boot hydrate is unchanged", () => {
  it("unions cached models not present in the fallback", () => {
    const fallback = makeProvider(OPENCODE, [model("a")]);
    const cached = makeProvider(OPENCODE, [model("a"), model("b")]);
    const hydrated = hydrateCachedProvider({ cachedProvider: cached, fallbackProvider: fallback });
    expect([...slugs(hydrated)].sort()).toEqual(["a", "b"]);
  });
});
