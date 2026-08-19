// ru-code: hidden context-compaction on the web side — the pure helpers AND the
// wired composite (deriveWorkLogEntries): the adapter's task.progress →
// task.completed pair must land as ONE morphing timeline row, and the
// "compaction in progress" flag must derive from the same persisted activities.
// Activity fixtures mirror ProviderRuntimeIngestion's task.progress /
// task.completed mapping byte-for-byte (payload.detail carries the text,
// payload.tone carries the breaker's warning override).
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../../../session-logic";
import {
  compactionCollapseKey,
  deriveIsCompactingContext,
  isTaskWarningToneRow,
  shouldMorphCompactionPair,
} from "../../workLog/contextCompaction";

const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}uuid-1`;
const PROGRESS_TEXT = "Идет сжатие контекста…";
const SUCCESS_TEXT = "Сжатие выполнено успешно (200000 -> 12345).";
const BREAKER_TEXT =
  "Сжатие почти не уменьшило контекст (200000 -> 199000). " +
  "Автоматическое сжатие отключено. Начните новый диалог, чтобы продолжить с чистым контекстом.";

let nextActivityId = 0;

function makeActivity(overrides: {
  kind: string;
  summary: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  const activityIndex = nextActivityId++;
  return {
    id: EventId.make(`activity-${activityIndex}`),
    // Strictly increasing, like real ingestion stamps — the work-log sorter
    // falls back to lifecycle-rank reordering on identical timestamps.
    createdAt: `2026-02-23T00:00:${String(activityIndex % 60).padStart(2, "0")}.000Z`,
    kind: overrides.kind,
    summary: overrides.summary,
    tone: overrides.tone ?? "info",
    payload: overrides.payload,
    turnId: null,
  };
}

// Mirrors ProviderRuntimeIngestion's `task.progress` row for the adapter's
// description-only compaction event.
const progressActivity = (taskId: string = TASK_ID) =>
  makeActivity({
    kind: "task.progress",
    summary: "Обновление рассуждений",
    payload: { taskId, detail: PROGRESS_TEXT },
  });

// Mirrors ProviderRuntimeIngestion's `task.completed` row (summary → detail;
// the optional tone override rides the payload).
const completedActivity = (input: {
  taskId?: string;
  status?: "completed" | "failed";
  detail?: string;
  tone?: "warning";
}) =>
  makeActivity({
    kind: "task.completed",
    summary: input.status === "failed" ? (input.detail ?? "Task failed") : "Task completed",
    tone: input.status === "failed" ? "error" : "info",
    payload: {
      taskId: input.taskId ?? TASK_ID,
      status: input.status ?? "completed",
      detail: input.detail ?? SUCCESS_TEXT,
      ...(input.tone ? { tone: input.tone } : {}),
    },
  });

describe("deriveIsCompactingContext", () => {
  it("is true while a compaction task.progress has no matching task.completed", () => {
    expect(deriveIsCompactingContext([progressActivity()])).toBe(true);
  });

  it("clears when the matching task.completed lands (any status)", () => {
    expect(deriveIsCompactingContext([progressActivity(), completedActivity({})])).toBe(false);
    expect(
      deriveIsCompactingContext([
        progressActivity(),
        completedActivity({ status: "failed", detail: "boom" }),
      ]),
    ).toBe(false);
  });

  it("a stopped closure (interrupt / boot sweep) unblocks too", () => {
    expect(
      deriveIsCompactingContext([
        progressActivity(),
        makeActivity({
          kind: "task.completed",
          summary: "Сжатие прервано перезапуском сервера.",
          payload: {
            taskId: TASK_ID,
            status: "stopped",
            detail: "Сжатие прервано перезапуском сервера.",
          },
        }),
      ]),
    ).toBe(false);
  });

  it("a finished compaction followed by a new one re-arms the flag", () => {
    const secondTaskId = `${CONTEXT_COMPACTION_TASK_PREFIX}uuid-2`;
    expect(
      deriveIsCompactingContext([
        progressActivity(),
        completedActivity({}),
        progressActivity(secondTaskId),
      ]),
    ).toBe(true);
  });

  it("ignores non-compaction task streams (e.g. Claude subagent progress)", () => {
    expect(
      deriveIsCompactingContext([
        makeActivity({
          kind: "task.progress",
          summary: "Обновление рассуждений",
          payload: { taskId: "subagent-task-1", detail: "working" },
        }),
      ]),
    ).toBe(false);
    expect(deriveIsCompactingContext([])).toBe(false);
  });
});

describe("compactionCollapseKey / isTaskWarningToneRow", () => {
  it("keys ONLY compaction task activities", () => {
    expect(compactionCollapseKey("task.progress", { taskId: TASK_ID })).toBe(`task:${TASK_ID}`);
    expect(compactionCollapseKey("task.completed", { taskId: TASK_ID })).toBe(`task:${TASK_ID}`);
    expect(compactionCollapseKey("task.progress", { taskId: "subagent-1" })).toBeUndefined();
    expect(compactionCollapseKey("tool.completed", { taskId: TASK_ID })).toBeUndefined();
    expect(compactionCollapseKey("task.progress", null)).toBeUndefined();
  });

  it("flags the warning tone only on a task.completed payload override", () => {
    expect(isTaskWarningToneRow("task.completed", { tone: "warning" })).toBe(true);
    expect(isTaskWarningToneRow("task.completed", { tone: "info" })).toBe(false);
    expect(isTaskWarningToneRow("task.completed", {})).toBe(false);
    expect(isTaskWarningToneRow("task.progress", { tone: "warning" })).toBe(false);
  });

  it("shouldMorphCompactionPair merges ONLY progress → same-key successor", () => {
    const key = `task:${TASK_ID}`;
    expect(shouldMorphCompactionPair("task.progress", key, key)).toBe(true);
    expect(shouldMorphCompactionPair("task.completed", key, key)).toBe(false);
    expect(shouldMorphCompactionPair("task.progress", key, `task:${TASK_ID}-other`)).toBe(false);
    expect(shouldMorphCompactionPair("task.progress", undefined, undefined)).toBe(false);
  });
});

describe("deriveWorkLogEntries — the morphing compaction row (wired composite)", () => {
  it("running compaction: one spinner row with the progress text", () => {
    const entries = deriveWorkLogEntries([progressActivity()]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe(PROGRESS_TEXT);
    expect(entries[0]!.tone).toBe("thinking");
  });

  it("progress + completed collapse into ONE row showing the final success text", () => {
    const entries = deriveWorkLogEntries([progressActivity(), completedActivity({})]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe(SUCCESS_TEXT);
    expect(entries[0]!.tone).toBe("info");
  });

  it("breaker trip morphs the row to WARNING tone with the full RU text (numbers included)", () => {
    const entries = deriveWorkLogEntries([
      progressActivity(),
      completedActivity({ detail: BREAKER_TEXT, tone: "warning" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe(BREAKER_TEXT);
    expect(entries[0]!.tone).toBe("warning");
  });

  it("a swept/interrupted compaction morphs the row to the stopped text (info tone)", () => {
    const entries = deriveWorkLogEntries([
      progressActivity(),
      makeActivity({
        kind: "task.completed",
        summary: "Сжатие прервано перезапуском сервера.",
        payload: {
          taskId: TASK_ID,
          status: "stopped",
          detail: "Сжатие прервано перезапуском сервера.",
        },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("Сжатие прервано перезапуском сервера.");
    expect(entries[0]!.tone).toBe("info");
  });

  it("a failed compaction morphs the row to ERROR tone with the failure text", () => {
    const entries = deriveWorkLogEntries([
      progressActivity(),
      completedActivity({ status: "failed", detail: "Не удалось сжать контекст: boom" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("Не удалось сжать контекст: boom");
    expect(entries[0]!.tone).toBe("error");
  });

  it("two different compactions stay two rows (keys are per-compaction)", () => {
    const secondTaskId = `${CONTEXT_COMPACTION_TASK_PREFIX}uuid-2`;
    const entries = deriveWorkLogEntries([
      progressActivity(),
      completedActivity({}),
      progressActivity(secondTaskId),
      completedActivity({
        taskId: secondTaskId,
        detail: "Сжатие выполнено успешно (9000 -> 100).",
      }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.label).toBe(SUCCESS_TEXT);
    expect(entries[1]!.label).toBe("Сжатие выполнено успешно (9000 -> 100).");
  });

  // ru-code: fixture rot fix (F2/F3) — t3 (native, unmarked) added its own
  // subagent-lifecycle grouping in `collapseDerivedWorkLogEntries`, which folds
  // consecutive `task.progress` ticks sharing a non-compaction taskId into ONE
  // row (agent-spawn CTA). This test predates that feature and asserted no
  // merge at all; the guarantee it actually protects — that a non-compaction
  // task stream is never mistaken for OUR compaction row (no `isContextCompaction`
  // flag, no warning tone) — is unaffected and re-asserted below.
  it("non-compaction task streams are never mistaken for a compaction row (no collateral tagging)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "Обновление рассуждений",
        payload: { taskId: "subagent-1", detail: "step 1" },
      }),
      makeActivity({
        kind: "task.progress",
        summary: "Обновление рассуждений",
        payload: { taskId: "subagent-1", detail: "step 2" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("isContextCompaction");
  });
});
