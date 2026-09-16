// ru-code (qwen-compression wave): the client half of the context-window
// supersede rule — `thread.activity-appended` in threadReducer.ts.
//
// A HIDDEN compaction has no active turn by construction (the adapter refuses to
// start one during a turn), so its `context-window.updated` row carries
// `turnId: null`. The reducer's supersede filter was keyed on an EQUAL turnId, so
// that row did not replace the previous turns' rows: it merely appended, and won
// the ring's backward walk only because `activityOrder` put it last. A row with
// no turn is a statement about the whole thread — the context was just rewritten
// — so it must replace every earlier row. The rule itself lives in
// @ru-code/context-window and is shared with the server's snapshot pruner.
import { describe, expect, it } from "vite-plus/test";

import { EventId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "../../../state/threadReducer.ts";

const THREAD = ThreadId.make("thread-ctx");

const baseThread: OrchestrationThread = {
  id: THREAD,
  projectId: ProjectId.make("project-1"),
  title: "Context Window Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  chatViewMode: null,
  settledOverride: null,
  settledAt: null,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

let nextSequence = 0;
const usageRow = (turnId: string | null, usedTokens: number): OrchestrationThreadActivity =>
  ({
    id: EventId.make(`activity-${String((nextSequence += 1))}`),
    sequence: nextSequence,
    createdAt: `2026-04-01T00:0${String(nextSequence % 10)}:00.000Z`,
    kind: "context-window.updated",
    summary: "Context window updated",
    tone: "info",
    turnId: turnId === null ? null : TurnId.make(turnId),
    payload: { usedTokens, maxTokens: 252_000 },
  }) as unknown as OrchestrationThreadActivity;

/** Append `activity` through the real reducer and return the resulting rows. */
const append = (
  thread: OrchestrationThread,
  activity: OrchestrationThreadActivity,
): OrchestrationThread => {
  const result = applyThreadDetailEvent(thread, {
    eventId: EventId.make(`event-${activity.id}`),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    sequence: nextSequence,
    occurredAt: activity.createdAt,
    aggregateKind: "thread",
    aggregateId: THREAD,
    type: "thread.activity-appended",
    payload: { threadId: THREAD, activity },
  } as never);
  if (result.kind !== "updated") throw new Error(`expected updated, got ${result.kind}`);
  return result.thread;
};

const usedTokensOf = (thread: OrchestrationThread): number[] =>
  thread.activities
    .filter((activity) => activity.kind === "context-window.updated")
    .map((activity) => (activity.payload as { usedTokens: number }).usedTokens);

describe("threadReducer — context-window supersede", () => {
  it("an ordinary usage row replaces only its OWN turn's earlier rows", () => {
    let thread = append(baseThread, usageRow("t1", 100));
    thread = append(thread, usageRow("t2", 200));
    thread = append(thread, usageRow("t2", 300));
    expect(usedTokensOf(thread)).toEqual([100, 300]);
  });

  it("a compaction row (turnId:null) replaces EVERY earlier row", () => {
    let thread = append(baseThread, usageRow("t1", 180_000));
    thread = append(thread, usageRow("t2", 190_000));
    thread = append(thread, usageRow(null, 12_345));
    expect(usedTokensOf(thread)).toEqual([12_345]);
  });

  it("the turn AFTER a compaction keeps its own row alongside it", () => {
    let thread = append(baseThread, usageRow("t1", 180_000));
    thread = append(thread, usageRow(null, 12_345));
    thread = append(thread, usageRow("t2", 13_001));
    expect(usedTokensOf(thread)).toEqual([12_345, 13_001]);
  });
});
