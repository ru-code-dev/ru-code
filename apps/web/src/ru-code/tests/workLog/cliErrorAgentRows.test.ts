// ru-code (P1 phantom-agent fix): a Qwen turn-level CLI-error row uses
// `task.completed` purely as transport for the classified error text — it
// must render as an ordinary error work-log row, never a phantom subagent +
// spawn CTA (the owner-observed «Отработал 1 субагент · 1 с ошибкой»).
// Modelled on compactionAgentRows.test.ts, which fixes both the green
// (stamped) and the legacy-red (already-persisted, unstamped) case for the
// sibling compaction fix.
import { CLI_ERROR_TASK_PREFIX, CLI_ERROR_TASK_TYPE } from "@ru-code/branding";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../../../session-logic";

const ERROR_TEXT = "Превышен лимит запросов.";
const TURN_ID = TurnId.make("turn-3f9c-abcd");

// Exactly what ProviderRuntimeIngestion writes for the FIXED emission site
// (QwenAdapter.ts:2577/2927 AFTER FIX-1): prefixed taskId, unconditional
// taskType stamp, agentKind classified background from it.
const fixedActivity: OrchestrationThreadActivity = {
  id: EventId.make("cli-error-fixed"),
  createdAt: "2026-08-24T00:00:00.000Z",
  kind: "task.completed",
  summary: ERROR_TEXT,
  tone: "error",
  payload: {
    taskId: `${CLI_ERROR_TASK_PREFIX}${TURN_ID}`,
    status: "failed",
    summary: ERROR_TEXT,
    agentKind: "background",
    taskType: CLI_ERROR_TASK_TYPE,
  },
  turnId: TURN_ID,
};

// LEGACY persisted shape: threads that failed a Qwen turn BEFORE FIX-1
// shipped. The adapter reused the turn id as the task id and stamped no
// taskType, so ingestion's classifyTaskAgentKind wrote agentKind "agent" —
// server-authoritative, replayed on every reload, unreachable by any later
// re-classification. FIX-2's `isBackgroundTaskActivity(payload, turnId)`
// seam is the only stamp-independent handle: `payload.taskId === turnId` is
// a signature no real agent's taskId can ever have.
const legacyPhantomActivity: OrchestrationThreadActivity = {
  id: EventId.make("cli-error-legacy"),
  createdAt: "2026-08-24T00:00:00.000Z",
  kind: "task.completed",
  summary: ERROR_TEXT,
  tone: "error",
  payload: {
    taskId: String(TURN_ID),
    status: "failed",
    summary: ERROR_TEXT,
    agentKind: "agent",
  },
  turnId: TURN_ID,
};

// A genuine agent row (real subagent), for the regression guard — proves the
// fix is scoped to the turnId-collision signature, not a blanket suppression.
const REGULAR_TASK_ID = "call-agent-1";
const regularAgentActivity: OrchestrationThreadActivity = {
  id: EventId.make("regular-agent"),
  createdAt: "2026-08-24T00:00:00.000Z",
  kind: "task.progress",
  summary: "Review the diff",
  tone: "info",
  payload: {
    taskId: REGULAR_TASK_ID,
    title: "Review the diff",
    detail: "Review the diff",
    agentKind: "agent",
    taskType: "subagent",
  },
  turnId: TURN_ID,
};

describe("cli-error rows (FIX-1, stamped) — no phantom agent", () => {
  it("the Agents roster stays empty", () => {
    expect(foldSubagentActivities([fixedActivity], { sessionLive: true })).toEqual([]);
  });

  it("renders ONE ordinary error work-log row, not a spawn CTA", () => {
    const entries = deriveWorkLogEntries([fixedActivity]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentSpawn).toBeUndefined();
    expect(entries[0]?.tone).toBe("error");
    expect(entries[0]?.label).toBe(ERROR_TEXT);
  });
});

describe("cli-error rows (FIX-2, legacy already-persisted phantom) — no phantom agent", () => {
  it("the fixture really is the pre-fix phantom shape (agent stamp, no taskType, taskId===turnId)", () => {
    const payload = legacyPhantomActivity.payload as Record<string, unknown>;
    expect(payload["agentKind"]).toBe("agent");
    expect(payload["taskType"]).toBeUndefined();
    expect(payload["taskId"]).toBe(String(legacyPhantomActivity.turnId));
  });

  it("the Agents roster stays empty (legacy seam catches the turnId-collision signature)", () => {
    expect(foldSubagentActivities([legacyPhantomActivity], { sessionLive: true })).toEqual([]);
  });

  it("renders ONE ordinary error work-log row, not a spawn CTA", () => {
    const entries = deriveWorkLogEntries([legacyPhantomActivity]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentSpawn).toBeUndefined();
    expect(entries[0]?.tone).toBe("error");
    expect(entries[0]?.label).toBe(ERROR_TEXT);
  });
});

describe("REGRESSION GUARD — a genuine agent row is unaffected by the legacy seam", () => {
  it("a real agent's task.started still joins the roster + drives a spawn CTA", () => {
    expect(foldSubagentActivities([regularAgentActivity], { sessionLive: true })).toHaveLength(1);
    const entries = deriveWorkLogEntries([regularAgentActivity]);
    expect(entries[0]?.agentSpawn).toBeDefined();
  });
});
