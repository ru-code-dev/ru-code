// ru-code: RENDER-LEVEL visibility of the boot-sweep request closures. After a
// server restart the sweep writes `approval.resolved` / `user-input.resolved`
// rows (turnId null, tone info) whose summary explains the cancellation. The
// user must SEE those rows — they are the only trace of why a parked
// approval/question vanished. Fixtures mirror qwenBootSweep's row specs
// byte-for-byte; the chain is the one MessagesTimeline renders from.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const CANCELLED_APPROVAL_TEXT = "Запрос подтверждения отменён перезапуском сервера.";
const CANCELLED_USER_INPUT_TEXT = "Вопрос отменён перезапуском сервера.";

let nextActivityId = 0;
function makeActivity(overrides: {
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`sweep-activity-${activityIndex}`),
    createdAt: `2026-03-02T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary,
    tone: "info",
    payload: overrides.payload,
    turnId: null,
  };
}

function renderRows(activities: ReadonlyArray<OrchestrationThreadActivity>): MessagesTimelineRow[] {
  const workLogEntries = deriveWorkLogEntries(activities);
  const timelineEntries = deriveTimelineEntries([], [], workLogEntries);
  return deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
}

const renderedWorkLabels = (rows: ReadonlyArray<MessagesTimelineRow>): string[] =>
  rows.flatMap((row) =>
    row.kind === "work" ? row.groupedEntries.map((entry) => entry.label) : [],
  );

describe("boot-sweep request closures — RENDERED timeline rows", () => {
  it("a swept approval renders its cancellation row", () => {
    const labels = renderedWorkLabels(
      renderRows([
        makeActivity({
          kind: "approval.resolved",
          summary: CANCELLED_APPROVAL_TEXT,
          payload: { requestId: "req-approval-1" },
        }),
      ]),
    );
    expect(labels).toContain(CANCELLED_APPROVAL_TEXT);
  });

  it("a swept question renders its cancellation row", () => {
    const labels = renderedWorkLabels(
      renderRows([
        makeActivity({
          kind: "user-input.resolved",
          summary: CANCELLED_USER_INPUT_TEXT,
          payload: { requestId: "req-question-1" },
        }),
      ]),
    );
    expect(labels).toContain(CANCELLED_USER_INPUT_TEXT);
  });
});
