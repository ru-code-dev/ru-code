// ru-code: the compaction pair must render as ONE ordinary morphing row and must
// NOT reach the Agents surface. Fixtures carry the server's `agentKind` stamp —
// the field the whole decision turns on and the field every earlier workLog
// fixture omitted, which is exactly how the CTA regression went unnoticed.
import { CONTEXT_COMPACTION_TASK_PREFIX, CONTEXT_COMPACTION_TASK_TYPE } from "@ru-code/branding";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../session-logic";

const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}rows-1`;
const PROGRESS_TEXT = "Compacting context…";
const SUCCESS_TEXT = "Compaction succeeded (200000 -> 12345).";

// Exactly what ProviderRuntimeIngestion writes for the two compaction events
// once the adapter stamps `taskType` (see the server-side companion suite,
// ru-code/tests/orchestration/compactionTaskClassification.test.ts).
const progressActivity = (agentKind: string): OrchestrationThreadActivity => ({
  id: EventId.make("compaction-rows-progress"),
  createdAt: "2026-08-20T00:00:00.000Z",
  kind: "task.progress",
  summary: PROGRESS_TEXT,
  tone: "info",
  payload: {
    taskId: TASK_ID,
    title: PROGRESS_TEXT,
    detail: PROGRESS_TEXT,
    agentKind,
    taskType: CONTEXT_COMPACTION_TASK_TYPE,
  },
  turnId: null,
});

// The completed limb carries `title` TOO: ingestion remembers the progress
// `description` per task and looks it up to title the completion activity
// (ProviderRuntimeIngestion.ts:760 `taskTitle`, cache at :967-985 — the
// stateful call site is `runtimeEventToActivities(event, taskTitle)` at :2117).
// Executed against the real ingestion, the completed payload is:
//   {taskId, status, title:"Compacting context…", summary:<outcome>,
//    detail:<outcome>, usage, agentKind:"background", taskType}
// so BOTH limbs must be suppressed. Omitting this field is what let the earlier
// fixture pass while modelling a row production never emits.
const completedActivity = (agentKind: string): OrchestrationThreadActivity => ({
  id: EventId.make("compaction-rows-completed"),
  createdAt: "2026-08-20T00:00:05.000Z",
  kind: "task.completed",
  summary: "Task completed",
  tone: "info",
  payload: {
    taskId: TASK_ID,
    status: "completed",
    title: PROGRESS_TEXT,
    summary: SUCCESS_TEXT,
    detail: SUCCESS_TEXT,
    usage: { preTokens: 200_000, postTokens: 12_345 },
    agentKind,
    taskType: CONTEXT_COMPACTION_TASK_TYPE,
  },
  turnId: null,
});

// LEGACY persisted shape: threads compacted by the pre-fix build. The adapter
// stamped no `taskType`, so ingestion's classifyTaskAgentKind wrote
// agentKind "agent" on both rows — which is server-authoritative and replayed
// on every reload, so these rows cannot be re-classified after the fact.
const legacyActivity = (activity: OrchestrationThreadActivity): OrchestrationThreadActivity => {
  const payload: Record<string, unknown> = {
    ...(activity.payload as Record<string, unknown>),
    agentKind: "agent",
  };
  delete payload["taskType"];
  return { ...activity, payload };
};

// A NON-compaction background task row, ingested byte-for-byte the same way
// (`title` on task.progress, `agentKind` stamp) — the control case for the
// owner's "t3 regular tools UI must not be affected" invariant.
const REGULAR_TITLE = "Research the bug";
const regularTaskProgress = (taskType: string): OrchestrationThreadActivity => ({
  id: EventId.make("regular-task-progress"),
  createdAt: "2026-08-20T00:00:00.000Z",
  kind: "task.progress",
  summary: REGULAR_TITLE,
  tone: "info",
  payload: {
    taskId: "call-agent-1",
    title: REGULAR_TITLE,
    detail: REGULAR_TITLE,
    agentKind: taskType === "plan" ? "background" : "agent",
    taskType,
  },
  turnId: null,
});

const renderedWorkEntries = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
  const workLogEntries = deriveWorkLogEntries(activities);
  const timelineEntries = deriveTimelineEntries([], [], workLogEntries);
  const rows = deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
  return rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
};

describe("compaction rows — background stamp keeps them in the chat", () => {
  const settled = [progressActivity("background"), completedActivity("background")];

  it("renders ONE row carrying the outcome, not a subagent CTA", () => {
    const entries = renderedWorkEntries(settled);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe(SUCCESS_TEXT);
    expect(entries[0]?.agentSpawn).toBeUndefined();
    expect(entries[0]?.isContextCompaction).toBe(true);
  });

  it("mid-compression the spinner row still renders on its own", () => {
    const entries = renderedWorkEntries([progressActivity("background")]);
    expect(entries.map((entry) => entry.label)).toContain(PROGRESS_TEXT);
    expect(entries[0]?.agentSpawn).toBeUndefined();
  });

  it("the Agents roster stays empty", () => {
    expect(foldSubagentActivities(settled, { sessionLive: true })).toEqual([]);
  });

  // REGRESSION GUARD, restated: the `agent` stamp is what produced the CTA row
  // + fake agent. It still does — for a row that is genuinely an agent. The
  // compaction taskId is now the stamp-independent override (see the LEGACY
  // describe below), so the guard proves the CTA machinery on a NON-compaction
  // taskId; asserting it on a compaction taskId would now assert the bug.
  it("REGRESSION GUARD: the `agent` stamp still produces the CTA row + roster entry", () => {
    const stampedAsAgent = [regularTaskProgress("subagent")];
    const entries = renderedWorkEntries(stampedAsAgent);
    expect(entries[0]?.agentSpawn).toBeDefined();
    expect(foldSubagentActivities(stampedAsAgent, { sessionLive: true })).toHaveLength(1);
  });

  // ru-code: the heading the screen prints is toolWorkEntryHeading(), which
  // prefers `toolTitle` over `label` (MessagesTimeline.tsx:2105-2110). Upstream
  // 749baec35 started stamping `title` on every task.progress payload, so the
  // compaction's progress title outlived the compaction and the outcome was
  // demoted to a "- suffix". These two cases pin the field the screen reads;
  // the pre-existing `label` cases above are green either way, which is exactly
  // how the regression slipped through.
  it("the settled row carries NO toolTitle, so its heading is the outcome", () => {
    const entries = renderedWorkEntries(settled);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolTitle).toBeUndefined();
    expect(entries[0]?.toolTitle ?? entries[0]?.label).toBe(SUCCESS_TEXT);
  });

  it("mid-compression the row's heading is the progress line, not a pinned title", () => {
    const entries = renderedWorkEntries([progressActivity("background")]);
    expect(entries[0]?.toolTitle).toBeUndefined();
    expect(entries[0]?.toolTitle ?? entries[0]?.label).toBe(PROGRESS_TEXT);
  });

  // F3: the COMPLETED limb on its own. `mergeDerivedWorkLogEntries` takes
  // `next.toolTitle ?? previous.toolTitle`, so the completed row's remembered
  // title alone is enough to re-pin the heading. A future narrowing of the
  // predicate to `task.progress` would leave the pair-level cases green and
  // still bring the bug back; this case would go red.
  it("the completed limb's remembered title is suppressed on its own", () => {
    const entries = deriveWorkLogEntries([completedActivity("background")]);
    expect(entries).toHaveLength(1);
    expect((completedActivity("background").payload as Record<string, unknown>)["title"]).toBe(
      PROGRESS_TEXT,
    );
    expect(entries[0]?.toolTitle).toBeUndefined();
    expect(entries[0]?.toolTitle ?? entries[0]?.label).toBe(SUCCESS_TEXT);
  });
});

// ru-code (F1): threads compacted by the PRE-FIX build carry agentKind "agent"
// on both rows — server-stamped, replayed on every reload, unreachable by any
// later re-classification. Those rows folded into a «Ran 1 subagent ✓ View ▸»
// CTA, which renders neither title field, so the heading cut above could not
// reach them: old threads stayed broken in a different way than new ones.
// `isBackgroundTask` now falls back to the compaction taskId prefix, which no
// legacy row can lack.
describe("LEGACY compaction rows (agentKind agent, no taskType) render like new ones", () => {
  const legacySettled = [
    legacyActivity(progressActivity("background")),
    legacyActivity(completedActivity("background")),
  ];

  it("the legacy pair is ONE ordinary chat row carrying the outcome, not a CTA", () => {
    const entries = renderedWorkEntries(legacySettled);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentSpawn).toBeUndefined();
    expect(entries[0]?.isContextCompaction).toBe(true);
    expect(entries[0]?.label).toBe(SUCCESS_TEXT);
  });

  it("the legacy row's rendered heading is the outcome, not the pinned progress title", () => {
    const entries = renderedWorkEntries(legacySettled);
    expect(entries[0]?.toolTitle).toBeUndefined();
    expect(entries[0]?.toolTitle ?? entries[0]?.label).toBe(SUCCESS_TEXT);
  });

  it("the legacy fixture really is the pre-fix shape (agent stamp, no taskType)", () => {
    const payload = legacySettled[0]?.payload as Record<string, unknown>;
    expect(payload["agentKind"]).toBe("agent");
    expect(payload["taskType"]).toBeUndefined();
    expect(String(payload["taskId"])).toContain(CONTEXT_COMPACTION_TASK_PREFIX);
  });

  // The Agents roster is folded in @t3tools/client-runtime, which reads the
  // `agentKind` stamp straight off the payload — so before the taskId-prefix
  // guard in `isBackgroundTaskActivity` a legacy thread showed one NAMELESS
  // agent in the panel (executed: length 1, name null). The chat-row fix could
  // not reach it: the fold never consults the work-log derivation.
  it("the legacy pair joins NO Agents roster entry", () => {
    expect(foldSubagentActivities(legacySettled, { sessionLive: true })).toEqual([]);
  });

  it("NON-compaction guard: a genuine agent row still folds to exactly 1", () => {
    expect(
      foldSubagentActivities([regularTaskProgress("subagent")], { sessionLive: true }),
    ).toHaveLength(1);
  });
});

// ru-code: the owner's second order — "this only must apply to compaction, t3
// regular tools UI must not be affected". The suppression is keyed on the
// compaction taskId prefix / taskType, so every other titled row keeps
// `toolTitle` exactly as upstream writes it. Executable pin, both stamps.
describe("NON-compaction invariant — titled rows keep toolTitle untouched", () => {
  it("an agent-stamped task row keeps its title", () => {
    const entries = deriveWorkLogEntries([regularTaskProgress("subagent")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolTitle).toBe(REGULAR_TITLE);
  });

  it("a NON-compaction background task row keeps its title too", () => {
    const entries = deriveWorkLogEntries([regularTaskProgress("plan")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolTitle).toBe(REGULAR_TITLE);
    expect(entries[0]?.isContextCompaction).toBeUndefined();
  });

  it("a compaction taskId with no taskType stamp is still suppressed (prefix alone)", () => {
    const [progress] = [progressActivity("background")];
    const payload = { ...(progress?.payload as Record<string, unknown>) };
    delete payload["taskType"];
    const entries = deriveWorkLogEntries([
      { ...(progress as OrchestrationThreadActivity), payload },
    ]);
    expect(entries[0]?.toolTitle).toBeUndefined();
  });
});
