import { describe, expect, it } from "vite-plus/test";

import {
  compactActionClosingPopover,
  type ContextUsageLevel,
  contextMeterAdvice,
  contextUsageColor,
  contextUsageLevel,
  contextUsagePercent,
} from "../../tokens-usage/usage";
import {
  CONTEXT_METER_NEUTRAL_COLOR,
  CONTEXT_USAGE_COLOR,
  DANGER_USED_PERCENT,
  WARNING_USED_PERCENT,
} from "../../tokens-usage/constants";

describe("contextUsageLevel", () => {
  it("< WARNING% => normal", () => {
    expect(contextUsageLevel(49, 100)).toBe("normal");
    expect(contextUsageLevel(0, 100)).toBe("normal");
  });

  it("[WARNING, DANGER) => warning", () => {
    expect(contextUsageLevel(WARNING_USED_PERCENT, 100)).toBe("warning");
    expect(contextUsageLevel(69, 100)).toBe("warning");
  });

  it(">= DANGER% => danger", () => {
    expect(contextUsageLevel(DANGER_USED_PERCENT, 100)).toBe("danger");
    expect(contextUsageLevel(85, 100)).toBe("danger");
  });

  it("> 100% => danger (level reads RAW, unclamped)", () => {
    expect(contextUsageLevel(150, 100)).toBe("danger");
  });

  it("maxTokens 0 or null => normal (window unknown, never gate)", () => {
    expect(contextUsageLevel(999, 0)).toBe("normal");
    expect(contextUsageLevel(999, null)).toBe("normal");
  });
});

describe("contextUsagePercent", () => {
  it("computes raw unclamped percent", () => {
    expect(contextUsagePercent(50, 100)).toBe(50);
    expect(contextUsagePercent(200, 100)).toBe(200);
  });

  it("0 when window unknown", () => {
    expect(contextUsagePercent(50, 0)).toBe(0);
    expect(contextUsagePercent(50, null)).toBe(0);
  });
});

describe("contextUsageColor", () => {
  it("maps each level to its theme token", () => {
    const cases: Array<[ContextUsageLevel, string]> = [
      ["normal", CONTEXT_USAGE_COLOR.normal],
      ["warning", CONTEXT_USAGE_COLOR.warning],
      ["danger", CONTEXT_USAGE_COLOR.danger],
    ];
    for (const [level, token] of cases) {
      expect(contextUsageColor(level)).toBe(token);
    }
    expect(contextUsageColor("normal")).toBe("var(--color-muted-foreground)");
    expect(contextUsageColor("warning")).toBe("var(--color-amber-500)");
    expect(contextUsageColor("danger")).toBe("var(--color-red-500)");
  });
});

describe("contextMeterAdvice (the whole gated decision)", () => {
  it("qwen normal: bands on, neutral level, muted ring, no advice", () => {
    const advice = contextMeterAdvice({
      usedTokens: 30,
      maxTokens: 100,
      compactsAutomatically: false,
    });
    expect(advice.showBands).toBe(true);
    expect(advice.level).toBe("normal");
    // bands ON but level normal => the muted (gray) ring, not the bands-off blue.
    expect(advice.ringColor).toBe(CONTEXT_USAGE_COLOR.normal);
    expect(advice.ringColor).not.toBe(CONTEXT_METER_NEUTRAL_COLOR);
    expect(advice.headline).toBeNull();
    expect(advice.showCompress).toBe(false);
    // ru-code: the manual «Сжать контекст» button is offered at ANY fill level
    // for providers without self-compaction.
    expect(advice.showCompactButton).toBe(true);
  });

  it("qwen warning: amber ring + >=50% headline + /compress", () => {
    const advice = contextMeterAdvice({
      usedTokens: 60,
      maxTokens: 100,
      compactsAutomatically: false,
    });
    expect(advice.level).toBe("warning");
    expect(advice.ringColor).toBe("var(--color-amber-500)");
    expect(advice.headline).toBe(
      `The context is ≥ ${WARNING_USED_PERCENT}% full, which lowers answer quality.`,
    );
    expect(advice.showCompress).toBe(true);
  });

  it("qwen danger: red ring + full headline + /compress", () => {
    const advice = contextMeterAdvice({
      usedTokens: 85,
      maxTokens: 100,
      compactsAutomatically: false,
    });
    expect(advice.level).toBe("danger");
    expect(advice.ringColor).toBe("var(--color-red-500)");
    expect(advice.headline).toBe("The context is full.");
    expect(advice.showCompress).toBe(true);
  });

  it("over-limit reads danger, not warning (RAW/unclamped)", () => {
    const advice = contextMeterAdvice({
      usedTokens: 150,
      maxTokens: 100,
      compactsAutomatically: false,
    });
    expect(advice.level).toBe("danger");
    expect(advice.ringColor).toBe("var(--color-red-500)");
  });

  it("ANTI-LEAK: compactsAutomatically (Claude/Codex) => bands off, blue, no advice, even at high fill", () => {
    const advice = contextMeterAdvice({
      usedTokens: 90,
      maxTokens: 100,
      compactsAutomatically: true,
    });
    expect(advice.showBands).toBe(false);
    expect(advice.level).toBe("normal");
    expect(advice.ringColor).toBe(CONTEXT_METER_NEUTRAL_COLOR);
    expect(advice.headline).toBeNull();
    expect(advice.showCompress).toBe(false);
    // ru-code: auto-compacting providers never get the manual compact button.
    expect(advice.showCompactButton).toBe(false);
  });

  it("unknown window (maxTokens null) => bands off, blue, no advice", () => {
    const advice = contextMeterAdvice({
      usedTokens: 999,
      maxTokens: null,
      compactsAutomatically: false,
    });
    expect(advice.showBands).toBe(false);
    expect(advice.ringColor).toBe(CONTEXT_METER_NEUTRAL_COLOR);
    expect(advice.showCompress).toBe(false);
    // ru-code: unknown window still offers the button — /compress works
    // regardless of whether the denominator is known.
    expect(advice.showCompactButton).toBe(true);
  });
});

describe("compactActionClosingPopover", () => {
  it("closes the popover FIRST, then dispatches the compaction", () => {
    const calls: string[] = [];
    const handler = compactActionClosingPopover(
      () => calls.push("close"),
      () => calls.push("compact"),
    );
    handler();
    expect(calls).toEqual(["close", "compact"]);
  });
});
