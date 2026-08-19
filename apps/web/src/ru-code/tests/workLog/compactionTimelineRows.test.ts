// ru-code: RENDER-LEVEL visibility of the compaction row — the composite the
// user actually sees: activities → deriveWorkLogEntries → deriveTimelineEntries
// → deriveMessagesTimelineRows (the function MessagesTimeline renders from).
// The earlier suites stopped at deriveWorkLogEntries and missed that
// buildTimelineRows drops "neutral tool" work entries — which is exactly what
// the thinking-tone spinner row classifies as, so NOTHING rendered while a
// compression ran. The mid-compression case below pins the guarantee:
// «Идет сжатие контекста…» must be a rendered row BEFORE any completion exists.
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}render-1`;
const PROGRESS_TEXT = "Идет сжатие контекста…";
const SUCCESS_TEXT = "Сжатие выполнено успешно (200000 -> 12345).";

let nextActivityId = 0;
function makeActivity(overrides: {
  kind: string;
  summary: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`render-activity-${activityIndex}`),
    createdAt: `2026-03-01T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary,
    tone: overrides.tone ?? "info",
    payload: overrides.payload,
    turnId: null,
  };
}

// Mirrors ProviderRuntimeIngestion's mapping of the adapter's events.
const progressActivity = () =>
  makeActivity({
    kind: "task.progress",
    summary: "Обновление рассуждений",
    payload: { taskId: TASK_ID, detail: PROGRESS_TEXT },
  });
const completedActivity = () =>
  makeActivity({
    kind: "task.completed",
    summary: "Task completed",
    payload: { taskId: TASK_ID, status: "completed", detail: SUCCESS_TEXT },
  });

// The full derivation chain ChatView + MessagesTimeline run, with an idle
// session (a compaction runs with NO active turn — no working indicator
// exists to stand in for the row).
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

const renderedWorkEntries = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));

// Circuit-breaker trip: same morphing pair, but the completion carries the
// payload tone override + the raw token numbers.
const BREAKER_TEXT =
  "Сжатие почти не уменьшило контекст (200000 -> 199000). Автоматическое сжатие отключено.";
const breakerActivity = () =>
  makeActivity({
    kind: "task.completed",
    summary: "Task completed",
    payload: {
      taskId: TASK_ID,
      status: "completed",
      detail: BREAKER_TEXT,
      tone: "warning",
      usage: { preTokens: 200_000, postTokens: 199_000 },
    },
  });

// Closure rows for a compaction that never finished: the adapter's live
// interrupt («Сжатие прервано.») and the boot sweep after a dead server
// («Сжатие прервано перезапуском сервера.») — both `status:"stopped"`.
const INTERRUPTED_LIVE_TEXT = "Сжатие прервано.";
const INTERRUPTED_SWEEP_TEXT = "Сжатие прервано перезапуском сервера.";
const stoppedActivity = (detail: string) =>
  makeActivity({
    kind: "task.completed",
    summary: detail,
    payload: { taskId: TASK_ID, status: "stopped", detail },
  });

describe("compaction row — RENDERED timeline rows (what the user sees)", () => {
  it("MID-COMPRESSION: the spinner row is rendered immediately, before any completion", () => {
    const labels = renderedWorkLabels(renderRows([progressActivity()]));
    expect(labels).toContain(PROGRESS_TEXT);
  });

  it("after completion: ONE rendered row with the final text (morph survives rendering)", () => {
    const rows = renderRows([progressActivity(), completedActivity()]);
    const labels = renderedWorkLabels(rows);
    expect(labels).toContain(SUCCESS_TEXT);
    expect(labels).not.toContain(PROGRESS_TEXT);
  });

  it("breaker trip: the amber row is rendered with its warning tone intact", () => {
    const entries = renderedWorkEntries(renderRows([progressActivity(), breakerActivity()]));
    const breakerEntry = entries.find((entry) => entry.label === BREAKER_TEXT);
    expect(breakerEntry).toBeDefined();
    expect(breakerEntry?.tone).toBe("warning");
  });

  it("title + advice body: summary renders as the label, detail as the expandable body", () => {
    const TITLE = "Сжатие не уменьшило контекст (15762 -> 16246).";
    const ADVICE =
      "Сжимать уже сжатый или короткий диалог неэффективно — CLI нужны новые сообщения, чтобы сжатие дало результат.";
    const entries = renderedWorkEntries(
      renderRows([
        progressActivity(),
        makeActivity({
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: TASK_ID,
            status: "completed",
            summary: TITLE,
            detail: ADVICE,
            tone: "warning",
            usage: { preTokens: 15_762, postTokens: 16_246 },
          },
        }),
      ]),
    );
    const row = entries.find((entry) => entry.label === TITLE);
    expect(row).toBeDefined();
    expect(row?.tone).toBe("warning");
    expect(row?.detail).toBe(ADVICE);
  });

  it("live interrupt: the stopped-closure row is rendered («Сжатие прервано.»)", () => {
    const labels = renderedWorkLabels(
      renderRows([progressActivity(), stoppedActivity(INTERRUPTED_LIVE_TEXT)]),
    );
    expect(labels).toContain(INTERRUPTED_LIVE_TEXT);
  });

  it("boot sweep: the restart-closure row is rendered («…перезапуском сервера.»)", () => {
    const labels = renderedWorkLabels(
      renderRows([progressActivity(), stoppedActivity(INTERRUPTED_SWEEP_TEXT)]),
    );
    expect(labels).toContain(INTERRUPTED_SWEEP_TEXT);
  });
});
