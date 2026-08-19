// ru-code: RENDER-LEVEL contract for error-row visibility vs the timeline's
// two collapsers. The rule: the LATEST turn with an error stays fully open
// (no «Worked for …» fold) and its error rows never hide behind the
// «+N previous log entries» cap; the moment a newer turn exists, the failed
// turn folds like any other. Clean turns fold instantly (stock behavior).
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const ERROR_TEXT = "Не удалось выполнить шаг — CLI вернул ошибку протокола.";
const TURN_A = TurnId.make("turn-err-1");
const TURN_B = TurnId.make("turn-next-2");

let nextActivityId = 0;
function makeActivity(overrides: {
  kind: string;
  summary: string;
  tone: OrchestrationThreadActivity["tone"];
  payload: Record<string, unknown>;
  turnId: TurnId | null;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`error-vis-${activityIndex}`),
    createdAt: `2026-03-03T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary,
    tone: overrides.tone,
    payload: overrides.payload,
    turnId: overrides.turnId,
  };
}

const errorActivity = (turnId: TurnId | null) =>
  makeActivity({
    kind: "task.completed",
    summary: ERROR_TEXT,
    tone: "error",
    payload: { taskId: `task-err-${nextActivityId}`, status: "failed", detail: ERROR_TEXT },
    turnId,
  });

const infoTaskActivity = (turnId: TurnId, label: string) =>
  makeActivity({
    kind: "task.completed",
    summary: label,
    tone: "info",
    payload: { taskId: `task-info-${nextActivityId}`, status: "completed", detail: label },
    turnId,
  });

const settledTurn = (turnId: TurnId): TimelineLatestTurn => ({
  turnId,
  state: "completed",
  startedAt: "2026-03-03T00:00:00.000Z",
  completedAt: "2026-03-03T00:00:50.000Z",
});

function renderRows(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: TimelineLatestTurn | null,
): MessagesTimelineRow[] {
  const workLogEntries = deriveWorkLogEntries(activities);
  const timelineEntries = deriveTimelineEntries([], [], workLogEntries);
  return deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn,
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
const foldRows = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.filter((row) => row.kind === "turn-fold");

describe("error rows vs the two timeline collapsers", () => {
  it("turn-less error rows are always rendered", () => {
    const labels = renderedWorkLabels(renderRows([errorActivity(null)], null));
    expect(labels).toContain(ERROR_TEXT);
  });

  it("LATEST settled turn WITH an error stays open — error visible, no fold", () => {
    const rows = renderRows(
      [infoTaskActivity(TURN_A, "Шаг выполнен"), errorActivity(TURN_A)],
      settledTurn(TURN_A),
    );
    expect(renderedWorkLabels(rows)).toContain(ERROR_TEXT);
    expect(foldRows(rows)).toHaveLength(0);
  });

  it("LATEST settled turn WITHOUT errors folds immediately (stock default)", () => {
    const rows = renderRows(
      [infoTaskActivity(TURN_A, "Шаг один"), infoTaskActivity(TURN_A, "Шаг два")],
      settledTurn(TURN_A),
    );
    expect(foldRows(rows)).toHaveLength(1);
    expect(renderedWorkLabels(rows)).not.toContain("Шаг один");
  });

  it("an OLDER turn's error folds once a newer turn is the latest", () => {
    const rows = renderRows(
      [infoTaskActivity(TURN_A, "Шаг один"), errorActivity(TURN_A)],
      settledTurn(TURN_B),
    );
    expect(renderedWorkLabels(rows)).not.toContain(ERROR_TEXT);
    expect(foldRows(rows)).toHaveLength(1);
  });

  it("inside the open latest turn the error never hides behind the «+N previous» cap", () => {
    // Error lands first, later rows would normally push it out of the single
    // visible slot; the error is pinned, only the info rows collapse.
    const rows = renderRows(
      [
        errorActivity(TURN_A),
        infoTaskActivity(TURN_A, "Шаг один"),
        infoTaskActivity(TURN_A, "Шаг два"),
      ],
      settledTurn(TURN_A),
    );
    const labels = renderedWorkLabels(rows);
    expect(labels).toContain(ERROR_TEXT);
    expect(labels).toContain("Шаг два");
    expect(labels).not.toContain("Шаг один");
    const toggle = rows.find((row) => row.kind === "work-toggle");
    expect(toggle).toBeDefined();
    expect(toggle?.kind === "work-toggle" && toggle.hiddenCount).toBe(1);
  });
});
