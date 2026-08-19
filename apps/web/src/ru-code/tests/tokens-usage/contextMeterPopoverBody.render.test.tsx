// ru-code: render proof for the context-meter popover body — the advice
// headline, the /compress hint, the auto-compact line, and the manual
// «Compact context» button. The body is extracted from ContextWindowMeter
// precisely because base-ui portals the popup, so none of this text is
// reachable through renderToStaticMarkup on the meter itself.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextMeterPopoverBody } from "../../tokens-usage/ContextMeterPopoverBody";
import { contextMeterAdvice } from "../../tokens-usage/usage";

const WARNING_HEADLINE = "The context is ≥ 50% full, which lowers answer quality.";
const COMPRESS_HINT = "compact the conversation history";
const COMPACT_BUTTON_LABEL = "Compact context";
// ru-code: wording comes from t3's tested helper (ContextWindowMeter.logic.ts:19)
// — model-precise, replaces the fork's earlier "{name} automatically compacts…".
const autoCompactLine = (model: string | null) =>
  model
    ? `Context for ${model} compacts automatically when needed.`
    : "Context compacts automatically when needed.";

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

/** Render the body exactly the way ContextWindowMeter feeds it (advice from the real module). */
function renderBody(
  usage: ContextWindowSnapshot,
  extra: {
    modelDisplayName?: string | null;
    onCompactContext?: (() => void) | null;
    compactDisabled?: boolean;
  } = {},
): string {
  const { ringColor, headline, showCompress, showCompactButton } = contextMeterAdvice(usage);
  return renderToStaticMarkup(
    <ContextMeterPopoverBody
      usage={usage}
      usedPercentage={usage.usedPercentage !== null ? `${Math.round(usage.usedPercentage)}%` : null}
      normalizedPercentage={Math.max(0, Math.min(100, usage.usedPercentage ?? 0))}
      ringColor={ringColor}
      headline={headline}
      showCompress={showCompress}
      showCompactButton={showCompactButton}
      modelDisplayName={extra.modelDisplayName ?? null}
      onCompactContext={extra.onCompactContext ?? null}
      compactDisabled={extra.compactDisabled ?? false}
    />,
  );
}

describe("ContextMeterPopoverBody — qwen advice (compactsAutomatically=false)", () => {
  it("warning fill (>=50%) => the headline is present", () => {
    const markup = renderBody(makeSnapshot({ usedTokens: 60, maxTokens: 100 }));
    expect(markup).toContain(WARNING_HEADLINE);
  });

  it("no compact handler => the /compress hint is present", () => {
    const markup = renderBody(makeSnapshot({ usedTokens: 60, maxTokens: 100 }));
    expect(markup).toContain("Send");
    expect(markup).toContain("/compress");
    expect(markup).toContain(COMPRESS_HINT);
    expect(markup).not.toContain(COMPACT_BUTTON_LABEL);
  });

  it("with handler => «Compact context» button shown, /compress hint gone", () => {
    const markup = renderBody(makeSnapshot({ usedTokens: 60, maxTokens: 100 }), {
      onCompactContext: () => {},
    });
    expect(markup).toContain(COMPACT_BUTTON_LABEL);
    expect(markup).not.toContain("/compress");
    expect(markup).not.toContain('disabled=""');
  });

  it("compactDisabled=true => the button renders disabled", () => {
    const markup = renderBody(makeSnapshot({ usedTokens: 60, maxTokens: 100 }), {
      onCompactContext: () => {},
      compactDisabled: true,
    });
    expect(markup).toContain(COMPACT_BUTTON_LABEL);
    expect(markup).toContain('disabled=""');
  });
});

describe("ContextMeterPopoverBody — auto-compacting provider", () => {
  it("shows the localized auto-compact line, never the button or advice", () => {
    const markup = renderBody(
      makeSnapshot({ usedTokens: 90, maxTokens: 100, compactsAutomatically: true }),
      { modelDisplayName: "Claude", onCompactContext: () => {} },
    );
    expect(markup).toContain(autoCompactLine("Claude"));
    expect(markup).not.toContain(COMPACT_BUTTON_LABEL);
    expect(markup).not.toContain(WARNING_HEADLINE);
    expect(markup).not.toContain("/compress");
  });

  it("falls back to the model-less sentence when there is no display name", () => {
    const markup = renderBody(
      makeSnapshot({ usedTokens: 90, maxTokens: 100, compactsAutomatically: true }),
    );
    expect(markup).toContain(autoCompactLine(null));
  });
});
