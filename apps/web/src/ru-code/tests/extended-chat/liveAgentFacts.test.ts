// ru-code: the W1 host adapter — ChatView's live agent registry (AgentPanelModel) →
// the extended-chat package's `LiveAgentFacts` contract (impl-p-report §5). The card's
// status is only as honest as this mapping: a wrong status word here makes a running
// agent read «завершён» or hides a cancelled one behind the file's stale evidence.
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveLiveAgentFacts } from "../../extended-chat/liveAgentFacts";

const row = (
  overrides: Partial<RuntimeSubagent> & Pick<RuntimeSubagent, "id">,
): RuntimeSubagent => ({
  kind: "subagent",
  title: "Discover project structure",
  role: "Explore",
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
  isBackgrounded: true,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-08-28T13:49:16.000Z",
  startedAt: "2026-08-28T13:49:16.000Z",
  completedAt: null,
  updatedAt: "2026-08-28T13:49:16.000Z",
  ...overrides,
});

const model = (
  directAgents: ReadonlyArray<RuntimeSubagent>,
  workflows: AgentPanelModel["workflows"] = [],
): AgentPanelModel => ({
  workflows,
  directAgents,
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: directAgents.length > 0 || workflows.length > 0,
  liveCount: 0,
});

describe("deriveLiveAgentFacts (AgentPanelModel → LiveAgentFacts)", () => {
  it("maps every registry status onto the contract's four words (cancel is a STOP, not a failure)", () => {
    const facts = deriveLiveAgentFacts(
      model([
        row({ id: "Explore-1", status: "pending" }),
        row({ id: "Explore-2", status: "running" }),
        row({ id: "Explore-3", status: "waiting" }),
        row({ id: "Explore-4", status: "completed", completedAt: "2026-08-28T13:50:00.000Z" }),
        row({ id: "Explore-5", status: "cancelled" }),
        row({ id: "Explore-6", status: "failed", error: "boom" }),
        row({ id: "Explore-7", status: "interrupted", error: "process died" }),
      ]),
    );
    expect((facts ?? []).map((fact) => [fact.taskId, fact.status])).toEqual([
      ["Explore-1", "running"],
      ["Explore-2", "running"],
      ["Explore-3", "running"],
      ["Explore-4", "completed"],
      ["Explore-5", "cancelled"],
      ["Explore-6", "failed"],
      // `interrupted` is how a USER CANCEL of a qwen background agent reaches the registry
      // (poll: cancelled → stopped; fold: stopped → interrupted) — amber «отменён», never red.
      ["Explore-7", "cancelled"],
    ]);
    expect(facts?.[3]?.completedAt).toBe("2026-08-28T13:50:00.000Z");
    expect(facts?.[6]?.error).toBe("process died");
  });

  it("omits idle rows (resumable — the file speaks) and non-subagent kinds (no task_id join)", () => {
    const facts = deriveLiveAgentFacts(
      model(
        [row({ id: "idle-1", status: "idle" }), row({ id: "wf-agent", kind: "workflow_agent" })],
        [
          {
            workflow: row({ id: "wf", kind: "workflow" }),
            phases: [
              {
                index: 0,
                title: "Phase 1",
                members: [row({ id: "member-1", kind: "workflow_agent" })],
                state: "running",
                activeCount: 1,
                settledCount: 0,
              },
            ],
            unphasedMembers: [row({ id: "member-2", kind: "subagent", status: "running" })],
          },
        ],
      ),
    );
    // Only the genuine `subagent` row, wherever it sits in the panel model.
    expect((facts ?? []).map((fact) => fact.taskId)).toEqual(["member-2"]);
  });

  it("carries the registry's progress / lastToolName / error / timestamps as-is", () => {
    const [fact] =
      deriveLiveAgentFacts(
        model([
          row({
            id: "general-purpose-9",
            progress: "Reading src/index.ts",
            lastToolName: "read_file",
            startedAt: "2026-08-28T13:49:16.000Z",
          }),
        ]),
      ) ?? [];
    expect(fact).toEqual({
      taskId: "general-purpose-9",
      status: "running",
      progress: "Reading src/index.ts",
      lastToolName: "read_file",
      error: null,
      startedAt: "2026-08-28T13:49:16.000Z",
      completedAt: null,
    });
  });

  it("an empty registry → null (the prop's default; no facts, the file speaks)", () => {
    expect(deriveLiveAgentFacts(model([]))).toBeNull();
    expect(deriveLiveAgentFacts(null)).toBeNull();
  });
});
