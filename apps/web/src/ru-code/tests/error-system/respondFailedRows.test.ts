// ru-code: RENDER-LEVEL contract of the amber respond-failed rows. The reactor
// writes `provider.*.respond.failed` with an English detail; the web must show
// ONE visible amber row whose label is the localized text, with the English
// detail suppressed. The localization + tone are only unit-tested today; these
// cases pin the whole chain the timeline renders from.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const STALE_TEXT = "The session expired — retry the request";

let nextActivityId = 0;
function makeRespondFailedActivity(overrides: {
  kind: "provider.approval.respond.failed" | "provider.user-input.respond.failed";
  summary: string;
  detail: string;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`respond-failed-${activityIndex}`),
    createdAt: `2026-03-04T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary,
    tone: "error",
    payload: { requestId: `req-${activityIndex}`, detail: overrides.detail },
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

const renderedWorkEntries = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));

describe("respond-failed rows — RENDERED amber timeline rows", () => {
  it("stale approval response: visible amber row with the localized label, English detail suppressed", () => {
    const entries = renderedWorkEntries(
      renderRows([
        makeRespondFailedActivity({
          kind: "provider.approval.respond.failed",
          summary: "Не удалось обработать ответ на подтверждение",
          detail: "Stale pending approval request: req-0. Provider callback state was lost.",
        }),
      ]),
    );
    const row = entries.find((entry) => entry.label === STALE_TEXT);
    expect(row).toBeDefined();
    expect(row?.tone).toBe("warning");
    expect(row?.detail).toBeUndefined();
  });

  it("stale question response: visible amber row with the localized label", () => {
    const entries = renderedWorkEntries(
      renderRows([
        makeRespondFailedActivity({
          kind: "provider.user-input.respond.failed",
          summary: "Не удалось обработать ответ на вопрос",
          detail: "Stale pending user-input request: req-1. Provider callback state was lost.",
        }),
      ]),
    );
    const row = entries.find((entry) => entry.label === STALE_TEXT);
    expect(row).toBeDefined();
    expect(row?.tone).toBe("warning");
  });
});
