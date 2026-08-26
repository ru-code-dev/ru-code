// ru-code (agents wave, phase 3): the CLIENT half of concurrent agents.
//
// The server e2e proves the WIRE now demultiplexes N simultaneously-open agents
// by tag (subAgentV2Matrix.broken.test.ts). This proves the roster and the chat
// CTA do the right thing with that wire: N live rows, each with its own
// narration, and a running count that reflects how many are actually working.
//
// It matters because until 0.21.1 the qwen path could only ever produce ONE open
// agent (the ACP session awaited each `agent` call before the next), so "N
// concurrent" was untested on this side — not because it was thought to work,
// but because it could not happen.
//
// Fixtures are the activities ingestion persists from the adapter's events.
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

const AGENT_A = "call-agent-A";
const AGENT_B = "call-agent-B";
const AGENT_C = "call-agent-C";
const TURN_ID = TurnId.make("turn-1");

let seq = 0;
const at = () => `2026-08-26T00:00:${String(seq++).padStart(2, "0")}.000Z`;

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  createdAt: at(),
  kind,
  summary: kind,
  tone: "info",
  payload,
  turnId: TURN_ID,
});

const started = (taskId: string, title: string, role: string) =>
  activity(`${taskId}-started`, "task.started", {
    taskId,
    taskType: "subagent",
    agentKind: "agent",
    title,
    role,
    toolUseId: taskId,
    detail: title,
  });

const progress = (taskId: string, summary: string, extra: Record<string, unknown> = {}) =>
  activity(`${taskId}-progress-${seq}`, "task.progress", {
    taskId,
    taskType: "subagent",
    agentKind: "agent",
    description: "d",
    summary,
    ...extra,
  });

const completed = (taskId: string, summary: string) =>
  activity(`${taskId}-completed`, "task.completed", {
    taskId,
    taskType: "subagent",
    agentKind: "agent",
    status: "completed",
    summary,
  });

const fold = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
  foldSubagentActivities(activities, { sessionLive: true });

describe("concurrent qwen agents — roster", () => {
  it("three simultaneously-open agents are three live rows, not one", () => {
    const agents = fold([
      started(AGENT_A, "Review the diff", "code-reviewer"),
      started(AGENT_B, "Plan the migration", "planner"),
      started(AGENT_C, "Write the tests", "tester"),
    ]);
    expect(agents).toHaveLength(3);
    expect(agents.map((agent) => agent.id).sort()).toEqual([AGENT_A, AGENT_B, AGENT_C].sort());
    expect(agents.every((agent) => agent.status === "running")).toBe(true);
  });

  // The exact cross-talk the single-window server model produced: whichever
  // window happened to be open collected everyone's words. Interleaving the
  // progress rows is what makes this a real check rather than a sequential one.
  it("keeps each agent's own narration on its own row when frames interleave", () => {
    const agents = fold([
      started(AGENT_A, "Review the diff", "code-reviewer"),
      started(AGENT_B, "Plan the migration", "planner"),
      progress(AGENT_A, "A is reading the diff"),
      progress(AGENT_B, "B is drafting the plan"),
      progress(AGENT_A, "A found three null checks"),
    ]);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    expect(byId.get(AGENT_A)?.progress).toBe("A found three null checks");
    expect(byId.get(AGENT_B)?.progress).toBe("B is drafting the plan");
    // The ring holds the row's own history and nobody else's. Note A's two
    // narration quanta collapse into ONE ring entry — consecutive narration for
    // the same agent updates in place rather than appending
    // (agentActivityRing.test.ts pins that), so the check that matters here is
    // that B's words never appear in A's ring at all.
    const ringA = (byId.get(AGENT_A)?.recentActivity ?? []).map((entry) => entry.summary).join(" ");
    const ringB = (byId.get(AGENT_B)?.recentActivity ?? []).map((entry) => entry.summary).join(" ");
    expect(ringA).toContain("A found three null checks");
    expect(ringA).not.toContain("drafting the plan");
    expect(ringB).toContain("drafting the plan");
    expect(ringB).not.toContain("null checks");
  });

  it("settling one agent leaves its siblings running", () => {
    const agents = fold([
      started(AGENT_A, "Review the diff", "code-reviewer"),
      started(AGENT_B, "Plan the migration", "planner"),
      completed(AGENT_A, "A done."),
    ]);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    expect(byId.get(AGENT_A)?.status).toBe("completed");
    expect(byId.get(AGENT_A)?.result).toBe("A done.");
    expect(byId.get(AGENT_B)?.status).toBe("running");
  });
});

describe("concurrent qwen agents — the chat CTA's live count", () => {
  // The CTA counts `running`/`waiting` itself off the model's direct agents
  // (MessagesTimeline.tsx:2141-2144 → `working = running + waiting`), and the
  // model ALSO publishes its own tallies. Both are asserted: they must not drift,
  // because a reader of the chat line and a reader of the panel footer would then
  // see two different numbers for the same fleet.
  const workingCount = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
    const model = deriveAgentPanelModel({ agents: fold(activities) });
    const rows = model.directAgents;
    const ctaWorking = rows.filter(
      (agent) =>
        agent.status === "running" || agent.status === "pending" || agent.status === "waiting",
    ).length;
    expect(ctaWorking).toBe(model.runningCount + model.waitingCount);
    return { total: rows.length, working: ctaWorking };
  };

  it("counts every agent that is actually working, not just the newest", () => {
    expect(
      workingCount([
        started(AGENT_A, "Review the diff", "code-reviewer"),
        started(AGENT_B, "Plan the migration", "planner"),
        started(AGENT_C, "Write the tests", "tester"),
      ]),
    ).toEqual({ total: 3, working: 3 });
  });

  // A child parked on a permission prompt still reads as working in the CTA (the
  // monitoring-pill rule: one steady in-flight presentation), so `waiting` must
  // be counted, not dropped.
  it("counts a permission-parked agent as working", () => {
    expect(
      workingCount([
        started(AGENT_A, "Review the diff", "code-reviewer"),
        started(AGENT_B, "Plan the migration", "planner"),
        progress(AGENT_B, "⏸ write_file", { status: "waiting" }),
      ]),
    ).toEqual({ total: 2, working: 2 });
  });

  it("drops the count as agents settle, and reaches zero when all are done", () => {
    expect(
      workingCount([
        started(AGENT_A, "Review the diff", "code-reviewer"),
        started(AGENT_B, "Plan the migration", "planner"),
        completed(AGENT_A, "A done."),
      ]),
    ).toEqual({ total: 2, working: 1 });

    expect(
      workingCount([
        started(AGENT_A, "Review the diff", "code-reviewer"),
        started(AGENT_B, "Plan the migration", "planner"),
        completed(AGENT_A, "A done."),
        completed(AGENT_B, "B done."),
      ]),
    ).toEqual({ total: 2, working: 0 });
  });
});
