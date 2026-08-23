// ru-code: qwen sub-agent activities → ONE chat CTA row + ONE Agents-panel row.
// Fixtures are the persisted activities ProviderRuntimeIngestion writes for the
// synthesized qwen lifecycle (taskType "subagent" ⇒ agentKind "agent"), so the
// two surfaces are pinned against the real server output, not a hand-made shape.
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const AGENT_CALL = "call-agent-1";
const INNER_CALL = "call-inner-1";
// ru-code(porter item3, adapted): this tree's OrchestrationThreadActivity.turnId
// is a branded TurnId (Schema.NullOr(TurnId)), not a plain string as in the spec
// tree — TurnId.make() satisfies the brand while keeping the same wire value.
const TURN_ID = TurnId.make("turn-1");

let seq = 0;
const at = () => `2026-08-20T00:00:${String(seq++).padStart(2, "0")}.000Z`;

const started: OrchestrationThreadActivity = {
  id: EventId.make("sub-started"),
  createdAt: at(),
  kind: "task.started",
  summary: "subagent task started",
  tone: "info",
  payload: {
    taskId: AGENT_CALL,
    taskType: "subagent",
    detail: "Review the diff",
    agentKind: "agent",
    title: "Review the diff",
    role: "code-reviewer",
    toolUseId: AGENT_CALL,
  },
  turnId: TURN_ID,
};

const agentToolRow: OrchestrationThreadActivity = {
  id: EventId.make("sub-agent-tool-row"),
  createdAt: at(),
  kind: "tool.updated",
  summary: "Agent: Review the diff",
  tone: "tool",
  payload: {
    itemType: "dynamic_tool_call",
    status: "inProgress",
    agentId: AGENT_CALL,
    parentToolUseId: AGENT_CALL,
  },
  turnId: TURN_ID,
};

const heartbeat: OrchestrationThreadActivity = {
  id: EventId.make("sub-heartbeat"),
  createdAt: at(),
  kind: "tool.progress",
  summary: "read_file",
  tone: "info",
  payload: {
    taskId: AGENT_CALL,
    toolName: "read_file",
    toolUseId: INNER_CALL,
    parentToolUseId: AGENT_CALL,
  },
  turnId: TURN_ID,
};

const innerToolRow: OrchestrationThreadActivity = {
  id: EventId.make("sub-inner-tool-row"),
  createdAt: at(),
  kind: "tool.completed",
  summary: "Read file",
  tone: "tool",
  payload: {
    itemType: "dynamic_tool_call",
    detail: "/a.ts",
    agentId: AGENT_CALL,
    parentToolUseId: AGENT_CALL,
  },
  turnId: TURN_ID,
};

const completed: OrchestrationThreadActivity = {
  id: EventId.make("sub-completed"),
  createdAt: at(),
  kind: "task.completed",
  summary: "Task completed",
  tone: "info",
  payload: {
    taskId: AGENT_CALL,
    status: "completed",
    summary: "Found 2 issues.",
    detail: "Found 2 issues.",
    agentKind: "agent",
    taskType: "subagent",
    title: "Review the diff",
    role: "code-reviewer",
    toolUseId: AGENT_CALL,
    typedUsage: {
      totalTokens: 4441,
      inputTokens: 4321,
      cachedInputTokens: 100,
      outputTokens: 120,
      reasoningOutputTokens: 7,
      toolUses: 5,
      durationMs: 4200,
    },
  },
  turnId: TURN_ID,
};

const LIVE = [started, agentToolRow, heartbeat, innerToolRow];
const SETTLED = [...LIVE, completed];

const chatEntries = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
  const workLogEntries = deriveWorkLogEntries(activities);
  const timelineEntries = deriveTimelineEntries([], [], workLogEntries);
  const rows = deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
  return rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
};

describe("qwen sub-agent run — chat surface", () => {
  it("collapses the whole run into ONE spawn CTA row", () => {
    const entries = chatEntries(SETTLED);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentSpawn?.agentTaskIds).toEqual([AGENT_CALL]);
    expect(entries[0]?.agentRole).toBe("code-reviewer");
  });

  it("hides the agent tool row and the inner tool rows (they belong to the agent)", () => {
    const labels = chatEntries(SETTLED).map((entry) => entry.label);
    expect(labels).not.toContain("Agent: Review the diff");
    expect(labels).not.toContain("Read file");
  });

  it("mid-flight the CTA row already exists", () => {
    const entries = chatEntries(LIVE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentSpawn).toBeDefined();
  });
});

describe("qwen sub-agent run — Agents surface", () => {
  it("settled: one row with title, role, result, tools and usage", () => {
    const [agent, ...rest] = foldSubagentActivities(SETTLED, { sessionLive: true });
    expect(rest).toEqual([]);
    expect(agent?.id).toBe(AGENT_CALL);
    expect(agent?.title).toBe("Review the diff");
    expect(agent?.role).toBe("code-reviewer");
    expect(agent?.status).toBe("completed");
    expect(agent?.result).toBe("Found 2 issues.");
    expect(agent?.lastToolName).toBe("read_file");
    expect(agent?.usage?.totalTokens).toBe(4441);
    expect(agent?.usage?.toolUses).toBe(5);
    // qwen ships no model/effort for sub-agents — the panel drops the chip.
    expect(agent?.model).toBeNull();
    expect(agent?.effort).toBeNull();
  });

  it("mid-flight: running, with the child's current tool on the activity line", () => {
    const [agent] = foldSubagentActivities(LIVE, { sessionLive: true });
    expect(agent?.status).toBe("running");
    expect(agent?.lastToolName).toBe("read_file");
    expect(agent?.recentActivity.at(-1)?.summary).toBe("▸ read_file");
  });

  it("a heartbeat for an UNKNOWN task is ignored (no phantom agent)", () => {
    // ru-code(porter item3, adapted): this tree's `payload` field is typed
    // Schema.Unknown (=> `unknown`), so the spread needs a cast the spec tree
    // (a narrower payload type) didn't need. Same fixture value either way.
    const orphan = {
      ...heartbeat,
      payload: { ...(heartbeat.payload as Record<string, unknown>), taskId: "call-unknown" },
    };
    expect(foldSubagentActivities([orphan], { sessionLive: true })).toEqual([]);
  });
});
