// ru-code: RENDER-LEVEL coverage of the pending-approval composer panel — the
// composite the user actually sees while a request is parked: ingestion-shaped
// activities → derivePendingApprovals → real panel/actions markup. The
// derivation and the adapter e2e are covered elsewhere; nothing drove the
// panel render (kind summaries, the four decision buttons) until now.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "../../../components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../../../components/chat/ComposerPendingApprovalPanel";
import { derivePendingApprovals } from "../../../session-logic";

let nextActivityId = 0;
function approvalRequestedActivity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`approval-activity-${activityIndex}`),
    createdAt: `2026-03-05T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: "approval.requested",
    summary: "Approval requested",
    tone: "approval",
    payload: { requestId: `req-${activityIndex}`, ...payload },
    turnId: null,
  };
}

function renderPanel(payload: Record<string, unknown>): string {
  const pending = derivePendingApprovals([approvalRequestedActivity(payload)]);
  expect(pending).toHaveLength(1);
  return renderToStaticMarkup(
    <ComposerPendingApprovalPanel approval={pending[0]!} pendingCount={pending.length} />,
  );
}

describe("pending approval panel — rendered markup per request kind", () => {
  it("command approval", () => {
    const markup = renderPanel({
      requestKind: "command",
      requestType: "command_execution_approval",
      detail: "bun run lint",
    });
    expect(markup).toContain("PENDING APPROVAL");
    expect(markup).toContain("Command approval requested");
  });

  it("file-read approval", () => {
    const markup = renderPanel({ requestKind: "file-read", requestType: "file_read_approval" });
    expect(markup).toContain("File-read approval requested");
  });

  it("file-change approval", () => {
    const markup = renderPanel({ requestKind: "file-change", requestType: "file_change_approval" });
    expect(markup).toContain("File-change approval requested");
  });

  it("unknown request type still shows the generic panel (safety net)", () => {
    const markup = renderPanel({ requestType: "mcp_tool_approval" });
    expect(markup).toContain("PENDING APPROVAL");
    expect(markup).toContain("Action approval requested");
  });

  it("held plan approval shows the plan summary", () => {
    const markup = renderPanel({ requestType: "plan_approval" });
    expect(markup).toContain("Plan ready to implement");
  });
});

describe("pending approval actions — the four decision buttons", () => {
  it("renders all four decisions, enabled while not responding", () => {
    const pending = derivePendingApprovals([
      approvalRequestedActivity({
        requestKind: "command",
        requestType: "command_execution_approval",
      }),
    ]);
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={pending[0]!.requestId}
        isResponding={false}
        onRespondToApproval={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("Cancel turn");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Always allow this session");
    expect(markup).toContain("Approve once");
    expect(markup).not.toContain('disabled=""');
  });

  it("all four disabled while a response is in flight", () => {
    const pending = derivePendingApprovals([
      approvalRequestedActivity({
        requestKind: "command",
        requestType: "command_execution_approval",
      }),
    ]);
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={pending[0]!.requestId}
        isResponding
        onRespondToApproval={() => Promise.resolve()}
      />,
    );
    const disabledCount = markup.split('disabled=""').length - 1;
    expect(disabledCount).toBe(4);
  });
});
