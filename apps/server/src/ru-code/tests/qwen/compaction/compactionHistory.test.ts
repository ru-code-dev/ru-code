// ru-code: the compaction-history readers — the WHOLE breaker decision and the
// boot sweep's dangling-work detection, pure over persisted activities. These
// are the restart-proof replacements for in-memory state, so every transition
// (trip, re-arm, numberless closures, interleaved requests) is pinned here.
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadCompactionState,
  findDanglingCompactionTaskIds,
  findDanglingParkedRequests,
  isAutoCompactDisarmed,
} from "../../../qwen/compaction/compactionHistory.ts";

const TASK_A = `${CONTEXT_COMPACTION_TASK_PREFIX}a`;
const TASK_B = `${CONTEXT_COMPACTION_TASK_PREFIX}b`;

let nextId = 0;
const activity = (kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make(`a-${nextId++}`),
  createdAt: `2026-03-01T00:00:${String(nextId % 60).padStart(2, "0")}.000Z`,
  kind,
  summary: kind,
  tone: "info",
  payload,
  turnId: null,
});

const progress = (taskId: string) => activity("task.progress", { taskId });
const completed = (taskId: string, usage?: { preTokens: number; postTokens: number }) =>
  activity("task.completed", {
    taskId,
    status: usage ? "completed" : "stopped",
    ...(usage ? { usage } : {}),
  });
const usageSnapshot = (usedTokens: number) =>
  activity("context-window.updated", { usedTokens, maxTokens: 252_000 });

describe("deriveThreadCompactionState", () => {
  it("empty history ⇒ no compaction, no samples", () => {
    expect(deriveThreadCompactionState([])).toEqual({
      lastCompaction: null,
      minUsedTokensSince: null,
    });
  });

  it("tracks the LAST completed compaction with numbers and the min usage since it", () => {
    const state = deriveThreadCompactionState([
      progress(TASK_A),
      completed(TASK_A, { preTokens: 300_000, postTokens: 50_000 }),
      usageSnapshot(120_000),
      progress(TASK_B),
      completed(TASK_B, { preTokens: 200_000, postTokens: 199_000 }),
      usageSnapshot(199_500),
      usageSnapshot(150_000),
    ]);
    expect(state.lastCompaction).toEqual({ preTokens: 200_000, postTokens: 199_000 });
    expect(state.minUsedTokensSince).toBe(150_000);
  });

  it("numberless closures (interrupted / swept) are NOT compactions — the previous numbers stand", () => {
    const state = deriveThreadCompactionState([
      completed(TASK_A, { preTokens: 200_000, postTokens: 199_000 }),
      usageSnapshot(199_500),
      progress(TASK_B),
      completed(TASK_B), // interrupted: no usage numbers
    ]);
    expect(state.lastCompaction).toEqual({ preTokens: 200_000, postTokens: 199_000 });
    expect(state.minUsedTokensSince).toBe(199_500);
  });

  it("usage samples BEFORE the last compaction never count as 'since'", () => {
    const state = deriveThreadCompactionState([
      usageSnapshot(10_000),
      completed(TASK_A, { preTokens: 200_000, postTokens: 199_000 }),
    ]);
    expect(state.minUsedTokensSince).toBeNull();
  });
});

describe("isAutoCompactDisarmed (disarm line = 151_200 for the default window)", () => {
  const DISARM_LINE = 151_200;

  it("no compaction yet ⇒ armed", () => {
    expect(
      isAutoCompactDisarmed({ lastCompaction: null, minUsedTokensSince: null }, DISARM_LINE),
    ).toBe(false);
  });

  it("last compaction effective (post below the line) ⇒ armed", () => {
    expect(
      isAutoCompactDisarmed(
        { lastCompaction: { preTokens: 200_000, postTokens: 50_000 }, minUsedTokensSince: null },
        DISARM_LINE,
      ),
    ).toBe(false);
  });

  it("last compaction near-no-op ⇒ DISARMED", () => {
    expect(
      isAutoCompactDisarmed(
        { lastCompaction: { preTokens: 200_000, postTokens: 199_000 }, minUsedTokensSince: null },
        DISARM_LINE,
      ),
    ).toBe(true);
  });

  it("usage dipped below the line since the trip ⇒ RE-ARMED", () => {
    expect(
      isAutoCompactDisarmed(
        {
          lastCompaction: { preTokens: 200_000, postTokens: 199_000 },
          minUsedTokensSince: 100_000,
        },
        DISARM_LINE,
      ),
    ).toBe(false);
  });

  it("usage stayed above the line since the trip ⇒ still disarmed", () => {
    expect(
      isAutoCompactDisarmed(
        {
          lastCompaction: { preTokens: 200_000, postTokens: 199_000 },
          minUsedTokensSince: 180_000,
        },
        DISARM_LINE,
      ),
    ).toBe(true);
  });
});

describe("findDanglingCompactionTaskIds", () => {
  it("progress without completed dangles; any completed status closes", () => {
    expect(findDanglingCompactionTaskIds([progress(TASK_A)])).toEqual([TASK_A]);
    expect(findDanglingCompactionTaskIds([progress(TASK_A), completed(TASK_A)])).toEqual([]);
    expect(
      findDanglingCompactionTaskIds([
        progress(TASK_A),
        completed(TASK_A, { preTokens: 1, postTokens: 1 }),
      ]),
    ).toEqual([]);
  });

  it("ignores non-compaction task streams and tracks tasks independently", () => {
    expect(
      findDanglingCompactionTaskIds([
        activity("task.progress", { taskId: "subagent-1" }),
        progress(TASK_A),
        completed(TASK_A),
        progress(TASK_B),
      ]),
    ).toEqual([TASK_B]);
  });
});

describe("findDanglingParkedRequests", () => {
  const approvalOpened = (requestId: string) =>
    activity("approval.requested", { requestId, requestKind: "command" });
  const questionOpened = (requestId: string) =>
    activity("user-input.requested", { requestId, questions: [] });

  it("opened without a terminal row dangles, with its kind", () => {
    expect(findDanglingParkedRequests([approvalOpened("r1"), questionOpened("r2")])).toEqual([
      { requestId: "r1", kind: "approval" },
      { requestId: "r2", kind: "user-input" },
    ]);
  });

  it("resolved and respond-failed rows both close", () => {
    expect(
      findDanglingParkedRequests([
        approvalOpened("r1"),
        activity("approval.resolved", { requestId: "r1" }),
        questionOpened("r2"),
        activity("provider.user-input.respond.failed", { requestId: "r2", detail: "x" }),
        approvalOpened("r3"),
        activity("provider.approval.respond.failed", { requestId: "r3", detail: "x" }),
      ]),
    ).toEqual([]);
  });

  it("re-opened after a resolve dangles again", () => {
    expect(
      findDanglingParkedRequests([
        approvalOpened("r1"),
        activity("approval.resolved", { requestId: "r1" }),
        approvalOpened("r1"),
      ]),
    ).toEqual([{ requestId: "r1", kind: "approval" }]);
  });
});
