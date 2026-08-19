// ru-code: work-run grouping respects turn boundaries. Fixture = the field
// scenario that used to cascade: a settled turn whose checkpoint-failure
// error row lands AFTER the terminal message, followed by a turn-less
// compression pair. With the client's latestTurn pointing elsewhere (the
// separate client-state race, fixed by the t3 sync), the render layer used to
// fuse the turn's hidden error with the compress row into ONE capped run —
// «+1 previous tool call» under the compress row, error re-inserted ABOVE
// it on expand. The grouping loop now breaks at turn boundaries, so these
// cases pin the healthy shape in BOTH latestTurn states.
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const TURN = TurnId.make("turn-x");
const OTHER_TURN = TurnId.make("turn-other");
const COMPACT_TASK = `${CONTEXT_COMPACTION_TASK_PREFIX}mess-1`;
const ERROR_TEXT = "Не удалось создать чекпоинт";
const COMPACT_TEXT = "Сжатие выполнено успешно (20000 -> 9000).";

let nextId = 0;
const activity = (over: {
  kind: string;
  summary: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId: TurnId | null;
  createdAt: string;
}): OrchestrationThreadActivity => ({
  id: EventId.make(`mess-${nextId++}`),
  createdAt: over.createdAt,
  kind: over.kind,
  summary: over.summary,
  tone: over.tone ?? "info",
  payload: over.payload ?? {},
  turnId: over.turnId,
});

const fixtureActivities = (): OrchestrationThreadActivity[] => {
  // Deterministic ids: the work-group expansion key derives from entry ids,
  // which must be identical across renders.
  nextId = 0;
  return [
    activity({
      kind: "checkpoint.capture.failed",
      summary: ERROR_TEXT,
      tone: "error",
      payload: { detail: "VCS operation is unsupported" },
      turnId: TURN,
      createdAt: "2026-03-11T00:00:05.000Z",
    }),
    activity({
      kind: "task.progress",
      summary: "Обновление рассуждений",
      payload: { taskId: COMPACT_TASK, detail: "Идет сжатие контекста…" },
      turnId: null,
      createdAt: "2026-03-11T00:00:06.000Z",
    }),
    activity({
      kind: "task.completed",
      summary: "Task completed",
      payload: { taskId: COMPACT_TASK, status: "completed", detail: COMPACT_TEXT },
      turnId: null,
      createdAt: "2026-03-11T00:00:07.000Z",
    }),
  ];
};

const terminalMessage = {
  id: MessageId.make("assistant-1"),
  role: "assistant" as const,
  text: "Готово.",
  turnId: TURN,
  createdAt: "2026-03-11T00:00:03.000Z",
  updatedAt: "2026-03-11T00:00:03.000Z",
  streaming: false,
};

function renderRows(input: {
  latestTurn: TimelineLatestTurn | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
}): MessagesTimelineRow[] {
  const workLogEntries = deriveWorkLogEntries(fixtureActivities());
  const timelineEntries = deriveTimelineEntries([terminalMessage] as never, [], workLogEntries);
  return deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn: input.latestTurn,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
    ...(input.expandedTurnIds ? { expandedTurnIds: input.expandedTurnIds } : {}),
    ...(input.expandedWorkGroupIds ? { expandedWorkGroupIds: input.expandedWorkGroupIds } : {}),
  });
}

const staleLatestTurn: TimelineLatestTurn = {
  turnId: OTHER_TURN,
  state: "completed",
  startedAt: "2026-03-11T00:00:00.000Z",
  completedAt: "2026-03-11T00:00:04.000Z",
};

const workLabels = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries.map((e) => e.label) : []));

describe("stale client latestTurn — the fold hides the error, but expanding it is truthful", () => {
  it("collapsed: the error stays inside «Worked for …», compress renders below the fold", () => {
    const rows = renderRows({ latestTurn: staleLatestTurn });
    expect(rows.filter((row) => row.kind === "turn-fold")).toHaveLength(1);
    const labels = workLabels(rows);
    expect(labels).toContain(COMPACT_TEXT);
    expect(labels).not.toContain(ERROR_TEXT);
    expect(rows.find((row) => row.kind === "work-toggle")).toBeUndefined();
  });

  it("expanded: the error renders as its own row ABOVE the compress row — no «+N previous» borrowing it", () => {
    const rows = renderRows({
      latestTurn: staleLatestTurn,
      expandedTurnIds: new Set([OTHER_TURN, TURN]),
    });
    const labels = workLabels(rows);
    expect(labels.indexOf(ERROR_TEXT)).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf(ERROR_TEXT)).toBeLessThan(labels.indexOf(COMPACT_TEXT));
    expect(rows.find((row) => row.kind === "work-toggle")).toBeUndefined();
  });
});

describe("INTENDED contract — a work run never mixes different turns", () => {
  it("turn rows and turn-less rows never share a «+N previous» group", () => {
    // Same fixture, fold expanded: the turn's error row and the turn-less
    // compress row must render as SEPARATE rows — no toggle borrowing the
    // turn's rows to count against the compress row.
    const rows = renderRows({
      latestTurn: staleLatestTurn,
      expandedTurnIds: new Set([OTHER_TURN, TURN]),
    });
    const labels = workLabels(rows);
    expect(labels).toContain(ERROR_TEXT);
    expect(labels).toContain(COMPACT_TEXT);
    expect(rows.find((row) => row.kind === "work-toggle")).toBeUndefined();
  });

  it("with a HEALTHY latestTurn the error turn stays open and compress stays separate", () => {
    const rows = renderRows({
      latestTurn: { ...staleLatestTurn, turnId: TURN },
    });
    const labels = workLabels(rows);
    expect(labels).toContain(ERROR_TEXT);
    expect(labels).toContain(COMPACT_TEXT);
    expect(rows.filter((row) => row.kind === "turn-fold")).toHaveLength(0);
    expect(rows.find((row) => row.kind === "work-toggle")).toBeUndefined();
  });
});
