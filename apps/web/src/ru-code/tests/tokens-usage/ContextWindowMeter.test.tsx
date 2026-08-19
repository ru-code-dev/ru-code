// ru-code: composite render proof that the REAL ContextWindowMeter applies the
// tokens-usage band decision — the ring stroke reflects contextMeterAdvice's
// color and the in-ring readout reflects the usage. This pins the anti-leak
// guarantee at the render boundary: an auto-compacting provider (Claude/Codex)
// keeps the neutral BLUE ring, never a warn/danger color.
//
// NOTE: the unit project runs in Node (no DOM), so base-ui's portaled popover
// body does NOT render in renderToStaticMarkup — only the trigger does. The
// popover-only advice text (headline + /compress + auto-compact line) is proven
// exhaustively against contextMeterAdvice in usage.test.ts, the single source
// the component renders from.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "../../../components/chat/ContextWindowMeter";
import { applySelectedModelWindow } from "../../tokens-usage/selectedModelContextWindow";

const WARNING_COLOR = "var(--color-amber-500)";
const DANGER_COLOR = "var(--color-red-500)";
const MUTED_COLOR = "var(--color-muted-foreground)"; // qwen normal band ring
const NEUTRAL_COLOR = "var(--color-blue-500)"; // bands OFF (auto-compact / unknown window)

/** Build a snapshot the way deriveLatestContextWindowSnapshot would (% clamped to 100). */
function makeSnapshot(opts: {
  usedTokens: number;
  maxTokens: number | null;
  compactsAutomatically?: boolean;
}): ContextWindowSnapshot {
  const { usedTokens, maxTokens, compactsAutomatically = false } = opts;
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
    compactsAutomatically,
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

/** The active band ring is the second <circle> (first is the neutral track). */
function ringStroke(markup: string): string | null {
  const strokes = [...markup.matchAll(/stroke="([^"]+)"/g)].map((m) => m[1]);
  return strokes[strokes.length - 1] ?? null;
}

describe("ContextWindowMeter ring (qwen, compactsAutomatically=false)", () => {
  it("normal band => muted (gray) ring, in-ring % text", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={makeSnapshot({ usedTokens: 30, maxTokens: 100 })} />,
    );
    expect(ringStroke(markup)).toBe(MUTED_COLOR);
    expect(markup).not.toContain(WARNING_COLOR);
    expect(markup).not.toContain(DANGER_COLOR);
    expect(markup).not.toContain(NEUTRAL_COLOR); // blue only when bands are OFF
    expect(markup).toContain(">30<"); // in-ring Math.round(usedPercentage)
  });

  it("warning band => amber ring", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={makeSnapshot({ usedTokens: 60, maxTokens: 100 })} />,
    );
    expect(ringStroke(markup)).toBe(WARNING_COLOR);
    expect(markup).toContain(">60<");
  });

  it("danger band => red ring", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={makeSnapshot({ usedTokens: 85, maxTokens: 100 })} />,
    );
    expect(ringStroke(markup)).toBe(DANGER_COLOR);
    expect(markup).toContain(">85<");
  });

  it("over-limit (used > max) => red ring, display % clamped to 100", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={makeSnapshot({ usedTokens: 150, maxTokens: 100 })} />,
    );
    expect(ringStroke(markup)).toBe(DANGER_COLOR);
    expect(markup).not.toContain(WARNING_COLOR);
    expect(markup).toContain(">100<");
  });
});

describe("ContextWindowMeter anti-leak (compactsAutomatically=true)", () => {
  it("Claude/Codex meter unchanged: neutral blue ring even at high fill, no band color", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={makeSnapshot({ usedTokens: 90, maxTokens: 100, compactsAutomatically: true })}
        modelDisplayName="Claude"
      />,
    );
    expect(ringStroke(markup)).toBe(NEUTRAL_COLOR);
    expect(markup).not.toContain(WARNING_COLOR);
    expect(markup).not.toContain(DANGER_COLOR);
    expect(markup).toContain(">90<");
  });
});

describe("ContextWindowMeter with the selected model's window applied", () => {
  it("shows the % computed from the NEW window, not the history one", () => {
    // History said 60/100k (60%, amber). The user picks a 200k model — the
    // very same usage is now 30% and the ring drops back to the normal band.
    const selectedModelView = applySelectedModelWindow(
      makeSnapshot({ usedTokens: 60, maxTokens: 100 }),
      200,
    )!;
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={selectedModelView} />);
    expect(markup).toContain(">30<");
    expect(ringStroke(markup)).toBe(MUTED_COLOR);
    expect(markup).not.toContain(WARNING_COLOR);
  });

  it("a SMALLER selected window pushes the same usage into the danger band", () => {
    const selectedModelView = applySelectedModelWindow(
      makeSnapshot({ usedTokens: 60, maxTokens: 200 }),
      80,
    )!;
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={selectedModelView} />);
    expect(markup).toContain(">75<");
    expect(ringStroke(markup)).toBe(DANGER_COLOR);
  });

  it("unknown selected window keeps the history-derived meter untouched", () => {
    const historySnapshot = makeSnapshot({ usedTokens: 60, maxTokens: 100 });
    const selectedModelView = applySelectedModelWindow(historySnapshot, null)!;
    expect(selectedModelView).toBe(historySnapshot);
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={selectedModelView} />);
    expect(markup).toContain(">60<");
    expect(ringStroke(markup)).toBe(WARNING_COLOR);
  });
});

describe("ContextWindowMeter unknown window (maxTokens=null)", () => {
  it("no bands, neutral ring, in-ring token-count fallback", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={makeSnapshot({ usedTokens: 1234, maxTokens: null })} />,
    );
    expect(ringStroke(markup)).toBe(NEUTRAL_COLOR);
    expect(markup).not.toContain(WARNING_COLOR);
    expect(markup).not.toContain(DANGER_COLOR);
    expect(markup).toContain(">1.2k<"); // formatContextWindowTokens fallback
  });
});
