// ru-code (sub-agents): the CLIENT half of "both stop endings finalize the row".
// The server e2e (subAgentFlow.e2e.test.ts) proves what the wire carries for each
// ending; this proves what the roster does with it.
//   · protocol cancel → qwen still sends the settling frame ('cancelled' +
//     terminateReason) → task.completed status "stopped" → row settles.
//   · ACP process death → NO settling frame at all → the row is still "running"
//     when the session dies, and only the sessionLive:false sweep finalizes it
//     (subagentRuntime.ts:650-661). Without the sweep the panel would show a
//     "Working" agent forever with no process behind it.
// Fixtures are the activities ingestion persists from the adapter's events.
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

const AGENT_CALL = "call-agent-1";
const TURN_ID = TurnId.make("turn-1");

let seq = 0;
const at = () => `2026-08-23T00:00:${String(seq++).padStart(2, "0")}.000Z`;

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
    detail: "Review the diff",
  });

// The live line the re-routed child narration produces.
const narration = (summary: string) =>
  activity(`sub-progress-${summary.slice(0, 8)}`, "task.progress", {
    taskId: AGENT_CALL,
    taskType: "subagent",
    agentKind: "agent",
    description: "Review the diff",
    summary,
  });

describe("qwen sub-agent endings", () => {
  it("child narration becomes the row's live line and its activity ring", () => {
    const [agent] = foldSubagentActivities(
      [started(), narration("Reading the diff"), narration("▸ read_file · 42 lines")],
      { sessionLive: true },
    );
    expect(agent?.status).toBe("running");
    expect(agent?.progress).toBe("▸ read_file · 42 lines");
    expect(agent?.recentActivity.map((entry) => entry.summary)).toEqual([
      "Reading the diff",
      "▸ read_file · 42 lines",
    ]);
  });

  it("ENDING 1 — protocol cancel: the settling frame stops the row, session alive", () => {
    const [agent] = foldSubagentActivities(
      [
        started(),
        narration("Drafting the migration plan"),
        activity("sub-completed", "task.completed", {
          taskId: AGENT_CALL,
          taskType: "subagent",
          agentKind: "agent",
          status: "stopped",
          summary: "Partial plan: 2 of 5 steps.",
          detail: "CANCELLED",
        }),
      ],
      { sessionLive: true },
    );
    // "stopped" folds to `interrupted`, which the panel renders as "Stopped".
    expect(agent?.status).toBe("interrupted");
    expect(agent?.result).toBe("Partial plan: 2 of 5 steps.");
    expect(agent?.completedAt).not.toBeNull();
  });

  it("ENDING 2 — dead ACP: no settling frame, the liveness sweep finalizes the row", () => {
    const rows = [started(), narration("Reading the diff")];
    // While the session is believed alive the row is legitimately still running.
    expect(foldSubagentActivities(rows, { sessionLive: true })[0]?.status).toBe("running");
    // session.exited clears liveness; the orphan must not read as working forever.
    const [swept] = foldSubagentActivities(rows, { sessionLive: false });
    expect(swept?.status).toBe("interrupted");
    expect(swept?.completedAt).not.toBeNull();
    // The child's last words survive the sweep — that line IS the run's record.
    expect(swept?.progress).toBe("Reading the diff");
  });
});
