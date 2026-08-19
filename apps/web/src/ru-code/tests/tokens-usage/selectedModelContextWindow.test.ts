// ru-code: pure contract of the selected-model window helpers — the meter's
// denominator swap (applySelectedModelWindow) and the picker's capacity gate
// (canHoldContext). Both must NEVER act on missing data: unknown window or
// unknown usage keeps the snapshot / keeps the model selectable.
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import {
  applySelectedModelWindow,
  canHoldContext,
  emptyContextWindowSnapshot,
  modelContextWindowTokens,
} from "~/ru-code/tokens-usage/selectedModelContextWindow";

/** Build a snapshot the way deriveLatestContextWindowSnapshot would (% clamped to 100). */
function makeSnapshot(opts: {
  usedTokens: number;
  maxTokens: number | null;
}): ContextWindowSnapshot {
  const { usedTokens, maxTokens } = opts;
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  const remainingTokens =
    maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
  return {
    usedTokens,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

describe("modelContextWindowTokens", () => {
  it("returns the served window when it is a usable positive size", () => {
    expect(modelContextWindowTokens({ contextWindowTokens: 262144 })).toBe(262144);
  });

  it("returns null for an absent option, absent field, or non-positive size", () => {
    expect(modelContextWindowTokens(undefined)).toBeNull();
    expect(modelContextWindowTokens({})).toBeNull();
    expect(modelContextWindowTokens({ contextWindowTokens: 0 })).toBeNull();
    expect(modelContextWindowTokens({ contextWindowTokens: -5 })).toBeNull();
  });
});

describe("applySelectedModelWindow", () => {
  it("replaces maxTokens with the selected model's window and recomputes the derived fields", () => {
    const historySnapshot = makeSnapshot({ usedTokens: 50_000, maxTokens: 100_000 });
    const adjusted = applySelectedModelWindow(historySnapshot, 200_000);

    expect(adjusted).not.toBeNull();
    expect(adjusted!.maxTokens).toBe(200_000);
    expect(adjusted!.usedPercentage).toBe(25);
    expect(adjusted!.remainingTokens).toBe(150_000);
    expect(adjusted!.remainingPercentage).toBe(75);
    // Non-derived fields ride along untouched.
    expect(adjusted!.usedTokens).toBe(50_000);
    expect(adjusted!.updatedAt).toBe(historySnapshot.updatedAt);
  });

  it("recomputes even when the history snapshot had NO window of its own", () => {
    const adjusted = applySelectedModelWindow(
      makeSnapshot({ usedTokens: 30_000, maxTokens: null }),
      100_000,
    );
    expect(adjusted!.maxTokens).toBe(100_000);
    expect(adjusted!.usedPercentage).toBe(30);
  });

  it("clamps like the history derivation when usage exceeds the new window", () => {
    const adjusted = applySelectedModelWindow(
      makeSnapshot({ usedTokens: 150_000, maxTokens: 200_000 }),
      100_000,
    );
    expect(adjusted!.usedPercentage).toBe(100);
    expect(adjusted!.remainingTokens).toBe(0);
    expect(adjusted!.remainingPercentage).toBe(0);
  });

  it("unknown selected window keeps the snapshot UNCHANGED (same reference)", () => {
    const historySnapshot = makeSnapshot({ usedTokens: 50_000, maxTokens: 100_000 });
    expect(applySelectedModelWindow(historySnapshot, null)).toBe(historySnapshot);
    expect(applySelectedModelWindow(historySnapshot, 0)).toBe(historySnapshot);
  });

  it("no snapshot stays no snapshot (meter stays hidden)", () => {
    expect(applySelectedModelWindow(null, 100_000)).toBeNull();
    expect(applySelectedModelWindow(null, null)).toBeNull();
  });
});

describe("emptyContextWindowSnapshot", () => {
  it("known window: a 0-used snapshot the meter can render immediately (draft/fresh chat)", () => {
    const snapshot = emptyContextWindowSnapshot(262144);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.usedTokens).toBe(0);
    expect(snapshot!.maxTokens).toBe(262144);
    expect(snapshot!.usedPercentage).toBe(0);
    expect(snapshot!.remainingTokens).toBe(262144);
    expect(snapshot!.remainingPercentage).toBe(100);
    // qwen never self-compacts — the popover must offer the (disabled) button.
    expect(snapshot!.compactsAutomatically).toBe(false);
  });

  it("unknown or unusable window: null — the meter stays hidden as before", () => {
    expect(emptyContextWindowSnapshot(null)).toBeNull();
    expect(emptyContextWindowSnapshot(0)).toBeNull();
    expect(emptyContextWindowSnapshot(-1)).toBeNull();
  });
});

describe("canHoldContext", () => {
  it("window smaller than the usage => false", () => {
    expect(canHoldContext({ contextWindowTokens: 100 }, 150)).toBe(false);
  });

  it("window exactly equal to the usage => true", () => {
    expect(canHoldContext({ contextWindowTokens: 100 }, 100)).toBe(true);
  });

  it("window larger than the usage => true", () => {
    expect(canHoldContext({ contextWindowTokens: 100 }, 50)).toBe(true);
  });

  it("unknown window => true, no matter the usage", () => {
    expect(canHoldContext({}, 10_000_000)).toBe(true);
    expect(canHoldContext(undefined, 10_000_000)).toBe(true);
    expect(canHoldContext({ contextWindowTokens: 0 }, 10_000_000)).toBe(true);
  });

  it("unknown usage (fresh chat) => true, no matter the window", () => {
    expect(canHoldContext({ contextWindowTokens: 1 }, null)).toBe(true);
  });
});
