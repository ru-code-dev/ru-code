// ru-code: the compaction task pair must classify as BACKGROUND end to end —
// ingestion's agentKind stamp and the sidebar liveness registry are the two
// consumers of the taskType, and both are exercised here with the real
// modules. The web-side consequence (no CTA row, empty roster) is covered by
// apps/web/src/ru-code/tests/workLog/compactionAgentRows.test.ts.
import {
  CONTEXT_COMPACTION_TASK_PREFIX,
  CONTEXT_COMPACTION_TASK_TYPE,
  QWEN_KIND,
} from "@ru-code/branding";
import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "../../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { make as makeThreadBackgroundLiveness } from "../../../orchestration/ThreadBackgroundLiveness.ts";

const THREAD_ID = ThreadId.make("thread-classify-1");
const TASK_ID = RuntimeTaskId.make(`${CONTEXT_COMPACTION_TASK_PREFIX}classify-1`);
// Branded constructors + `satisfies`, the shape the port's own ingestion tests use
// (ProviderRuntimeIngestion.activity.test.ts:12-41) — no casts, so a contract change
// fails the typecheck here instead of silently drifting.
const base = { provider: ProviderDriverKind.make(QWEN_KIND), threadId: THREAD_ID };

const progressEvent = (taskType?: string) =>
  ({
    ...base,
    type: "task.progress",
    eventId: EventId.make("evt-progress"),
    createdAt: "2026-08-20T00:00:00.000Z",
    payload: {
      taskId: TASK_ID,
      description: "Compacting context…",
      ...(taskType !== undefined ? { taskType } : {}),
    },
  }) satisfies ProviderRuntimeEvent;

const completedEvent = (taskType?: string) =>
  ({
    ...base,
    type: "task.completed",
    eventId: EventId.make("evt-completed"),
    createdAt: "2026-08-20T00:00:05.000Z",
    payload: {
      taskId: TASK_ID,
      status: "completed",
      summary: "Compaction succeeded (200000 -> 12345).",
      usage: { preTokens: 200_000, postTokens: 12_345 },
      ...(taskType !== undefined ? { taskType } : {}),
    },
  }) satisfies ProviderRuntimeEvent;

describe("compaction task rows — ingestion agentKind stamp", () => {
  it("stamps agentKind background on BOTH rows of the pair", () => {
    const activities = [
      ...runtimeEventToActivities(progressEvent(CONTEXT_COMPACTION_TASK_TYPE)),
      ...runtimeEventToActivities(completedEvent(CONTEXT_COMPACTION_TASK_TYPE)),
    ];
    expect(activities).toHaveLength(2);
    for (const activity of activities) {
      const payload = activity.payload as Record<string, unknown>;
      expect(payload.agentKind).toBe("background");
      expect(payload.taskType).toBe(CONTEXT_COMPACTION_TASK_TYPE);
      expect(payload.taskId).toBe(TASK_ID);
    }
  });

  it("without the taskType the same rows are stamped `agent` (the regression)", () => {
    const [progress] = runtimeEventToActivities(progressEvent());
    expect((progress!.payload as Record<string, unknown>).agentKind).toBe("agent");
  });

  it("carries the outcome text and the raw token numbers through unchanged", () => {
    const [completed] = runtimeEventToActivities(completedEvent(CONTEXT_COMPACTION_TASK_TYPE));
    const payload = completed!.payload as Record<string, unknown>;
    expect(payload.summary).toBe("Compaction succeeded (200000 -> 12345).");
    expect(payload.usage).toEqual({ preTokens: 200_000, postTokens: 12_345 });
  });
});

describe("compaction task rows — sidebar background liveness", () => {
  it("an inert compaction never pins the Working pill", () => {
    const liveness = makeThreadBackgroundLiveness();
    liveness.recordTaskLiveness({
      threadId: THREAD_ID,
      taskId: TASK_ID,
      taskType: CONTEXT_COMPACTION_TASK_TYPE,
      status: undefined,
      agentId: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(THREAD_ID)).toBeNull();
  });

  it("without the taskType the same transition pins Working (the regression)", () => {
    const liveness = makeThreadBackgroundLiveness();
    liveness.recordTaskLiveness({
      threadId: THREAD_ID,
      taskId: TASK_ID,
      taskType: undefined,
      status: undefined,
      agentId: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(THREAD_ID)).toBe("working");
  });

  it("a real subagent still pins Working (the delta is scoped to the inert literal)", () => {
    const liveness = makeThreadBackgroundLiveness();
    liveness.recordTaskLiveness({
      threadId: THREAD_ID,
      taskId: "call-agent-1",
      taskType: "subagent",
      status: undefined,
      agentId: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(THREAD_ID)).toBe("working");
  });
});
