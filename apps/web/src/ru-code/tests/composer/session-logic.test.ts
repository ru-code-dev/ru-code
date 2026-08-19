import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingApprovals } from "../../../session-logic";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "approval.requested",
    summary: overrides.summary ?? "Approval requested",
    tone: overrides.tone ?? "approval",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
  };
}

describe("derivePendingApprovals — qwen plan_approval held approvals", () => {
  it("admits a plan_approval request that carries no requestKind", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        payload: {
          requestId: "req-plan-1",
          // qwen `exit_plan_mode` held approval: no command/file requestKind,
          // only the canonical requestType. It must still enter the pending
          // list (keyed off requestType === "plan_approval").
          requestType: "plan_approval",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-plan-1",
        requestType: "plan_approval",
        createdAt: "2026-02-23T00:00:01.000Z",
      },
    ]);
  });

  it("resolves a held plan_approval once its approval.resolved arrives", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-approval-open-2",
        createdAt: "2026-02-23T00:00:01.000Z",
        payload: { requestId: "req-plan-2", requestType: "plan_approval" },
      }),
      makeActivity({
        id: "plan-approval-close-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-plan-2" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it('surfaces any unhandled approval kind generically as requestKind "other"', () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "unknown-approval",
        createdAt: "2026-02-23T00:00:01.000Z",
        payload: {
          requestId: "req-unknown",
          // A held approval whose canonical requestType we have no dedicated
          // affordance for (web-fetch, MCP non-read, search, etc.). It must
          // still surface — dropping it hangs the held server RPC forever.
          requestType: "unknown",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-unknown",
        requestKind: "other",
        requestType: "unknown",
        createdAt: "2026-02-23T00:00:01.000Z",
      },
    ]);
  });

  it('admits a persisted "other" requestKind directly', () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "other-approval",
        createdAt: "2026-02-23T00:00:01.000Z",
        payload: {
          requestId: "req-other",
          requestKind: "other",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-other",
        requestKind: "other",
        createdAt: "2026-02-23T00:00:01.000Z",
      },
    ]);
  });
});
