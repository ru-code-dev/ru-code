// ru-code (agentic-flow wave, live-issues T2): THE CONSUMER HALF OF THE SEAM.
//
// `agentStopButton.test.ts` pins the ruled predicate against a hand-built
// `RuntimeSubagent`; `agentStopButton.render.test.tsx` pins that the panel
// renders the control for such a model. Neither says anything about where
// `isBackgrounded` COMES FROM — and that is exactly where the owner's live
// defect lived: the server dropped the field on the persisted row, so the fold
// produced `isBackgrounded: false` and every running background agent rendered
// no stop square while both specs above stayed green.
//
// This spec closes that gap from the client side: it folds ACTIVITY ROWS of the
// shape ingestion writes (`runtimeEventToActivities` →
// `taskLinkageActivityFields`, ProviderRuntimeIngestion.ts:341-380) and asserts
// the button predicate on the result. The producer half is pinned by
// `backgroundStopButtonProjection.e2e.test.ts` in apps/server, which asserts the
// same field on the real SQL projection.
import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";

import { canStopAgent } from "../../agents/AgentStopButton";

const TASK_ID = "general-purpose-5e6f7a8b";

/**
 * One persisted activity row, in the shape ingestion writes it: `agentKind` is
 * the server stamp the fold trusts (subagentRuntime.ts:130-159), and the linkage
 * bundle rides every row by contract (providerRuntime.ts:577-591).
 */
const activity = (
  kind: "task.started" | "task.progress",
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id: `${kind}:${TASK_ID}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    tone: "info",
    kind,
    summary: kind,
    turnId: null,
    payload: {
      taskId: TASK_ID,
      taskType: "subagent",
      agentKind: "agent",
      title: "Audit the config",
      ...payload,
    },
  }) as unknown as OrchestrationThreadActivity;

const foldOne = (rows: ReadonlyArray<OrchestrationThreadActivity>) => {
  const agents = foldSubagentActivities(rows, { sessionLive: true });
  expect(agents).toHaveLength(1);
  return agents[0]!;
};

describe("the persisted activity row is what lights the stop button", () => {
  it("a running background row folds to a STOPPABLE agent", () => {
    const agent = foldOne([
      activity("task.started", { isBackgrounded: true }),
      activity("task.progress", { isBackgrounded: true, status: "running" }),
    ]);
    expect(agent.status).toBe("running");
    expect(agent.isBackgrounded).toBe(true);
    expect(canStopAgent(agent)).toBe(true);
  });

  it("THE DEFECT: rows that lost `isBackgrounded` fold to an unstoppable agent", () => {
    // Exactly the payloads the server wrote before the linkage copier carried
    // the field: still a real, running agent row — just with no way to stop it.
    const agent = foldOne([
      activity("task.started", {}),
      activity("task.progress", { status: "running" }),
    ]);
    expect(agent.status).toBe("running");
    expect(agent.isBackgrounded).toBe(false);
    expect(canStopAgent(agent)).toBe(false);
  });

  it("the flag is STICKY: a later row carrying only taskId+status keeps the button", () => {
    // Terminal and progress rows commonly carry no marker fields at all, which
    // is why the contract repeats the bundle on every row. A row that forgot it
    // was background between two events would flicker the control.
    const agent = foldOne([
      activity("task.started", { isBackgrounded: true }),
      activity("task.progress", { status: "running" }),
    ]);
    expect(agent.isBackgrounded).toBe(true);
    expect(canStopAgent(agent)).toBe(true);
  });

  it("a FOREGROUND agent row stays unstoppable — the ruled `bg && running` half", () => {
    const agent = foldOne([
      activity("task.started", {}),
      activity("task.progress", { status: "running" }),
    ]);
    expect(canStopAgent(agent)).toBe(false);
  });
});
