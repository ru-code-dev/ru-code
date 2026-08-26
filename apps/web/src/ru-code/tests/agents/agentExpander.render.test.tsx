// ru-code (sub-agents): COMPONENT-LEVEL twin of agentDetails.logic.test.ts.
// The logic can be right while nothing reaches the screen, so these cases pin
// the markup — including the two invariants the port seam must not break:
// a detail-less agent keeps the flat, non-interactive row, and the expander's
// affordance is absolutely positioned so the row's height never changes.
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentDetails } from "../../agents/AgentDetails";
import { AgentRowExpander } from "../../agents/AgentRowExpander";

const agent = (overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent => ({
  id: "call-agent-1",
  kind: "subagent",
  isBackgrounded: false, // ru-code (agentic-flow wave)
  title: "Review the diff",
  role: "code-reviewer",
  model: null,
  effort: null,
  status: "completed",
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-08-23T00:00:00.000Z",
  startedAt: "2026-08-23T00:00:00.000Z",
  completedAt: "2026-08-23T00:00:05.000Z",
  updatedAt: "2026-08-23T00:00:05.000Z",
  ...overrides,
});

const rich = agent({
  result: `Found 2 issues. ${"detail ".repeat(60)}`,
  recentActivity: [
    { at: "2026-08-23T00:00:01.000Z", summary: "▸ read_file" },
    { at: "2026-08-23T00:00:02.000Z", summary: "▸ read_file · 42 lines" },
  ],
  usage: {
    totalTokens: 4441,
    inputTokens: 4321,
    cachedInputTokens: 100,
    outputTokens: 120,
    reasoningOutputTokens: 7,
    toolUses: 5,
    durationMs: 4200,
  },
});

describe("AgentDetails", () => {
  it("renders the fields nothing rendered before: full result, ring, five stats", () => {
    const html = renderToStaticMarkup(<AgentDetails agent={rich} />);
    // The FULL result, not the row's 180-char slice.
    expect(html).toContain(rich.result!.slice(-20));
    // The activity ring, newest first.
    expect(html.indexOf("42 lines")).toBeLessThan(html.lastIndexOf("▸ read_file"));
    // The stats the collapsed row drops (it keeps totalTokens + toolUses only).
    for (const value of ["4.3k", "100", "120", "7", "4s"]) {
      expect(html).toContain(value);
    }
  });

  it("renders an error instead of a result and marks it destructive", () => {
    const html = renderToStaticMarkup(<AgentDetails agent={agent({ error: "boom" })} />);
    expect(html).toContain("boom");
    expect(html).toContain("text-destructive-foreground");
  });

  // ru-code (livejitter): every free-text surface in the expander clamps to 3
  // lines instead of a hard single-line `truncate` (ring entries) or an
  // unbounded scroll box (result) — readable wrapped text, bounded height.
  // Full text is kept via the repo's Tooltip (result/error — the same pattern
  // ThreadErrorBanner.tsx uses, since a native `title` trips
  // t3code(no-native-title-tooltip)); ring entries drop the tooltip
  // (dispatch-approved: capped at 180 chars, already fits 3 wrapped lines,
  // and a per-row tooltip on a list that updates in place while streaming
  // would be noisy) — their full text is still the DOM node's own content,
  // just visually clamped. Mutation target: drop any one `line-clamp-3`
  // below and its assertion goes red, nothing else.
  it("clamps every free-text surface to 3 lines and keeps the full text in the DOM", () => {
    const longResult = `Found 2 issues. ${"detail ".repeat(60)}`;
    const html = renderToStaticMarkup(
      <AgentDetails
        agent={agent({
          result: longResult,
          recentActivity: [{ at: "2026-08-23T00:00:01.000Z", summary: "▸ read_file · 42 lines" }],
        })}
      />,
    );
    const clampCount = (html.match(/line-clamp-3/g) ?? []).length;
    // Result + one ring entry = 2 surfaces present in this fixture.
    expect(clampCount).toBe(2);
    // No native `title` attribute anywhere — the lint rule this dispatch fixed.
    expect(html).not.toContain("title=");
    // The clamp is CSS-only (line-clamp-3): the FULL string is still the
    // rendered node's own text content, not JS-truncated (the popup itself
    // is closed by default and does not reach static markup, but the
    // trigger's own content — this exact assertion — already proves the
    // text was never cut).
    expect(html).toContain(longResult);
    expect(html).toContain("▸ read_file · 42 lines");
  });

  it("clamps the error surface too, via Tooltip rather than a native title", () => {
    const longError = "boom ".repeat(60).trim();
    const html = renderToStaticMarkup(<AgentDetails agent={agent({ error: longError })} />);
    expect(html).toContain("line-clamp-3");
    expect(html).not.toContain("title=");
    expect(html).toContain(longError);
  });
});

describe("AgentRowExpander", () => {
  it("keeps the flat, non-interactive row when there is nothing to unfold", () => {
    const html = renderToStaticMarkup(
      <AgentRowExpander agent={agent()} row={<div data-testid="row" />} />,
    );
    expect(html).toContain('data-testid="row"');
    expect(html).not.toContain("<button");
  });

  it("wraps the row in a collapsed, height-neutral toggle when there is", () => {
    const html = renderToStaticMarkup(
      <AgentRowExpander agent={rich} row={<div data-testid="row" />} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="false"');
    // Collapsed ⇒ the body is absent, so nothing can push the roster around.
    expect(html).not.toContain('data-testid="agent-details"');
    // The chevron is absolutely positioned — the row's own grid is untouched.
    expect(html).toContain("absolute");
  });
});
