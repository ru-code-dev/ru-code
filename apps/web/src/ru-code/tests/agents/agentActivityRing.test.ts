// ru-code (livejitter): the recent-activity ring's replace-not-append seam
// (packages/client-runtime/src/state/subagentRuntime.ts — the `task.progress`
// arm's summary handling), pinned against the REAL exported
// `foldSubagentActivities` rather than the upstream port's own suite. Per
// RULES 8.1 this feature's pins live in the zone, not in the port test file —
// precedent: workLog/subAgentPanelRows.test.ts and workLog/compactionAgentRows
// .test.ts fold real OrchestrationThreadActivity fixtures the same way.
//
// Mutation target: route the `task.progress` summary through the port's plain
// `appendActivity` instead of the seam's `appendOrReplaceActivity` and the
// first test below goes red — the ring cycles once per narration tick instead
// of updating one entry in place.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

const TASK_ID = "call-agent-1";

let seq = 0;
const at = () => `2026-08-24T00:00:${String(seq++).padStart(2, "0")}.000Z`;

const started = (): OrchestrationThreadActivity => ({
  id: EventId.make(`ring-started-${seq}`),
  createdAt: at(),
  kind: "task.started",
  summary: "subagent task started",
  tone: "info",
  payload: {
    taskId: TASK_ID,
    taskType: "subagent",
    detail: "Review the diff",
    agentKind: "agent",
    title: "Review the diff",
    role: "code-reviewer",
    toolUseId: TASK_ID,
  },
  turnId: null,
});

const progress = (summary: string): OrchestrationThreadActivity => ({
  id: EventId.make(`ring-progress-${seq}`),
  createdAt: at(),
  kind: "task.progress",
  summary,
  tone: "info",
  payload: {
    taskId: TASK_ID,
    taskType: "subagent",
    agentKind: "agent",
    summary,
  },
  turnId: null,
});

describe("recent-activity ring: replace-not-append while one continuation streams", () => {
  it("narration quanta from the SAME continuation update one ring entry in place", () => {
    const [agent] = foldSubagentActivities([
      started(),
      progress("Reading the diff"),
      progress("Reading the diff and looking"),
      progress("Reading the diff and looking for null checks"),
    ]);
    expect(agent?.recentActivity).toHaveLength(1);
    expect(agent?.recentActivity[0]?.summary).toBe("Reading the diff and looking for null checks");
  });

  it("an interleaved tool result appends a second entry, not a replacement", () => {
    const [agent] = foldSubagentActivities([
      started(),
      progress("Reading the diff"),
      progress("▸ read_file · 42 lines"),
    ]);
    expect(agent?.recentActivity.map((e) => e.summary)).toEqual([
      "Reading the diff",
      "▸ read_file · 42 lines",
    ]);
  });

  it("narration resuming after a transition opens a fresh entry (settle appends)", () => {
    const [agent] = foldSubagentActivities([
      started(),
      progress("Reading the diff"),
      progress("▸ read_file · 42 lines"),
      progress("Drafting the review"),
    ]);
    expect(agent?.recentActivity.map((e) => e.summary)).toEqual([
      "Reading the diff",
      "▸ read_file · 42 lines",
      "Drafting the review",
    ]);
  });
});
