// ru-code (P2 zombie settle): the owner's exact symptom — an agent Stopped
// mid-run "resurrected" as Working with a countdown that read as though it
// never paused, because the fold's "interrupted" was a `sessionLive:false`
// overlay recomputed from scratch every render and thrown away the moment a
// new turn flipped `sessionLive` back to true (AgentsPanel.tsx:89-114 restarts
// its 1-second timer whenever status reads "running" again). The fix
// (settleOpenSubAgentAsStopped, QwenAdapter.ts) makes the Stop PERSISTED — a
// real `task.completed{status:"stopped"}` row — so the row reads "interrupted"
// regardless of the current `sessionLive` value. Sibling of subAgentEndings.test.ts.
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

const AGENT_CALL = "call-agent-1";
const TURN_ID = TurnId.make("turn-1");

let seq = 0;
const at = () => `2026-08-24T10:00:${String(seq++).padStart(2, "0")}.000Z`;

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

const started = () =>
  activity("sub-started", "task.started", {
    taskId: AGENT_CALL,
    taskType: "subagent",
    agentKind: "agent",
    title: "Review the diff",
    role: "code-reviewer",
    toolUseId: AGENT_CALL,
  });

const progress = () =>
  activity("sub-progress", "task.progress", {
    taskId: AGENT_CALL,
    taskType: "subagent",
    agentKind: "agent",
    description: "Review the diff",
    summary: "Reading the diff",
  });

// The settleOpenSubAgentAsStopped shape, field-for-field (QwenAdapter.ts).
const stopSettle = () =>
  activity("sub-stop-settle", "task.completed", {
    taskId: AGENT_CALL,
    status: "stopped",
    taskType: "subagent",
    agentKind: "agent",
    toolUseId: AGENT_CALL,
    title: "Review the diff",
    role: "code-reviewer",
    detail: "Stopped by the user.",
  });

// The literal `AgentsPanel.tsx:89-114` timer-live predicate.
const timerLive = (status: string | undefined) => status === "running" || status === "waiting";

describe("zombie agent settle — the owner's exact symptom", () => {
  it("WITH the settle row: status/completedAt/timer stay frozen across sessionLive flips", () => {
    const rows = [started(), progress(), stopSettle()];
    const passes = [true, false, true, true].map(
      (sessionLive) => foldSubagentActivities(rows, { sessionLive })[0],
    );
    for (const agent of passes) {
      expect(agent?.status).toBe("interrupted");
      expect(agent?.completedAt).toBe("2026-08-24T10:00:02.000Z"); // the terminal row's own timestamp
      expect(timerLive(agent?.status)).toBe(false);
    }
    // Every pass agrees byte-for-byte — no resurrection, no sliding duration.
    expect(new Set(passes.map((agent) => `${agent?.status}|${agent?.completedAt}`)).size).toBe(1);
  });

  it("NEGATIVE TWIN — without the settle row, sessionLive flipping back to true resurrects it", () => {
    const rows = [started(), progress()]; // no terminal row at all
    const duringRun = foldSubagentActivities(rows, { sessionLive: true })[0];
    const afterStop = foldSubagentActivities(rows, { sessionLive: false })[0];
    const nextTurn = foldSubagentActivities(rows, { sessionLive: true })[0];
    expect(duringRun?.status).toBe("running");
    expect(afterStop?.status).toBe("interrupted"); // the sessionLive:false overlay
    // The bug: the overlay is fold-local and recomputed from scratch — the
    // moment sessionLive flips back to true the row reads "running" again,
    // and AgentsPanel's timer restarts against the ORIGINAL startedAt.
    expect(nextTurn?.status).toBe("running");
    expect(timerLive(nextTurn?.status)).toBe(true);
    expect(nextTurn?.completedAt).toBeNull();
  });
});
