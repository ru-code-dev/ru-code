// ru-code (sub-agents): the expander's model. Every field asserted here is one
// the fold already computed and NOTHING rendered — `recentActivity` had zero
// consumers under apps/web, and AgentRow shows 2 of the 7 usage stats.
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  agentUsageStats,
  buildAgentDetailsModel,
  hasAgentDetails,
} from "../../agents/agentDetails.logic";

const plain = (value: number) => String(value);

const agent = (overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent => ({
  id: "call-agent-1",
  kind: "subagent",
  title: "Review the diff",
  role: "code-reviewer",
  model: null,
  effort: null,
  status: "running",
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
  completedAt: null,
  updatedAt: "2026-08-23T00:00:01.000Z",
  ...overrides,
});

describe("agentUsageStats", () => {
  it("surfaces the five stats the collapsed row throws away, in a stable order", () => {
    const stats = agentUsageStats(
      {
        totalTokens: 4441,
        inputTokens: 4321,
        cachedInputTokens: 100,
        outputTokens: 120,
        reasoningOutputTokens: 7,
        toolUses: 5,
        durationMs: 4200,
      },
      plain,
    );
    expect(stats.map((stat) => stat.key)).toEqual([
      "input",
      "cached",
      "output",
      "reasoning",
      "toolCalls",
      "duration",
    ]);
    expect(stats.find((stat) => stat.key === "duration")?.value).toBe("4s");
    expect(stats.find((stat) => stat.key === "toolCalls")?.value).toBe("5");
  });

  it("omits a stat it has no value for rather than rendering an empty row", () => {
    expect(agentUsageStats({ totalTokens: 10 }, plain)).toEqual([]);
    expect(agentUsageStats(null, plain)).toEqual([]);
  });

  it("formats a long run in minutes, not four-digit seconds", () => {
    const stats = agentUsageStats({ totalTokens: 1, durationMs: 605_000 }, plain);
    expect(stats[0]?.value).toBe("10m 05s");
  });
});

describe("buildAgentDetailsModel", () => {
  it("puts the newest activity first — the line the user just watched", () => {
    const model = buildAgentDetailsModel(
      agent({
        recentActivity: [
          { at: "2026-08-23T00:00:01.000Z", summary: "▸ read_file" },
          { at: "2026-08-23T00:00:02.000Z", summary: "▸ read_file · 42 lines" },
        ],
      }),
      plain,
    );
    expect(model.activity.map((entry) => entry.summary)).toEqual([
      "▸ read_file · 42 lines",
      "▸ read_file",
    ]);
  });

  it("carries the FULL result — the row can only ever show 180 chars of it", () => {
    const long = "x".repeat(400);
    expect(buildAgentDetailsModel(agent({ result: long }), plain).result).toBe(long);
  });

  it("reports re-activations only when there was more than one run", () => {
    expect(buildAgentDetailsModel(agent(), plain).activations).toBeNull();
    expect(buildAgentDetailsModel(agent({ activationCount: 3 }), plain).activations).toBe(3);
  });
});

describe("hasAgentDetails", () => {
  it("is false for an agent whose whole state is already on the row", () => {
    expect(hasAgentDetails(buildAgentDetailsModel(agent({ progress: "working" }), plain))).toBe(
      false,
    );
  });

  it("is true as soon as one otherwise-dead field carries something", () => {
    for (const overrides of [
      { result: "done" },
      { error: "boom" },
      { outputFile: "/tmp/out.md" },
      { activationCount: 2 },
      { recentActivity: [{ at: "2026-08-23T00:00:01.000Z", summary: "▸ read_file" }] },
      { usage: { totalTokens: 10, toolUses: 2 } },
    ] satisfies ReadonlyArray<Partial<RuntimeSubagent>>) {
      expect(hasAgentDetails(buildAgentDetailsModel(agent(overrides), plain))).toBe(true);
    }
  });
});
