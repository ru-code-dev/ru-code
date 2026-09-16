// ru-code (qwen-compression wave): the context-window retention rule, pure, plus
// the server snapshot pruner that delegates to it.
//
// THE CASE THIS EXISTS FOR: a hidden compaction has no active turn by
// construction (`compactContext` refuses to start during one), so its usage row
// lands with `turnId: null`. Keyed per turn that row formed a bucket of its own
// and coexisted with the previous turn's rows, winning the consumer's backward
// walk only because it happened to sort last. A row with no turn is a statement
// about the whole thread, so it must supersede every earlier row.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { contextWindowSupersedes, retainCurrentContextWindowRows } from "@ru-code/context-window";
import { describe, expect, it } from "vite-plus/test";

import { projectThreadDetailSnapshot } from "../../../orchestration/ActivityPayloadProjection.ts";

let nextId = 0;
const usageRow = (turnId: string | null, usedTokens: unknown): OrchestrationThreadActivity =>
  ({
    id: EventId.make(`a-${String((nextId += 1))}`),
    createdAt: `2026-03-01T00:00:${String(nextId % 60).padStart(2, "0")}.000Z`,
    kind: "context-window.updated",
    summary: "Context window updated",
    tone: "info",
    turnId,
    payload: { usedTokens, maxTokens: 252_000 },
  }) as unknown as OrchestrationThreadActivity;

const otherRow = (turnId: string | null): OrchestrationThreadActivity =>
  ({
    id: EventId.make(`a-${String((nextId += 1))}`),
    createdAt: `2026-03-01T00:01:${String(nextId % 60).padStart(2, "0")}.000Z`,
    kind: "message.appended",
    summary: "something else",
    tone: "info",
    turnId,
    payload: {},
  }) as unknown as OrchestrationThreadActivity;

const usedTokensOf = (activities: ReadonlyArray<OrchestrationThreadActivity>): unknown[] =>
  activities
    .filter((activity) => activity.kind === "context-window.updated")
    .map((activity) => (activity.payload as { usedTokens?: unknown }).usedTokens);

describe("contextWindowSupersedes", () => {
  it("a turn's row supersedes only its own turn's earlier rows", () => {
    expect(contextWindowSupersedes("t1", "t1")).toBe(true);
    expect(contextWindowSupersedes("t1", "t2")).toBe(false);
    expect(contextWindowSupersedes("t1", null)).toBe(false);
  });

  it("a row with NO turn supersedes everything earlier", () => {
    expect(contextWindowSupersedes(null, "t1")).toBe(true);
    expect(contextWindowSupersedes(null, "t2")).toBe(true);
    expect(contextWindowSupersedes(null, null)).toBe(true);
  });
});

describe("retainCurrentContextWindowRows", () => {
  const isUsage = (activity: OrchestrationThreadActivity): boolean =>
    activity.kind === "context-window.updated" &&
    typeof (activity.payload as { usedTokens?: unknown }).usedTokens === "number";
  const turnOf = (activity: OrchestrationThreadActivity): string | null => activity.turnId;
  const retain = (rows: ReadonlyArray<OrchestrationThreadActivity>) =>
    retainCurrentContextWindowRows(rows, isUsage, turnOf);

  it("keeps the last row of each turn", () => {
    const rows = [
      usageRow("t1", 100),
      usageRow("t1", 200),
      usageRow("t2", 300),
      usageRow("t2", 400),
    ];
    expect(usedTokensOf(retain(rows))).toEqual([200, 400]);
  });

  it("a turnId:null row drops every earlier row, whatever turn owned it", () => {
    const rows = [
      usageRow("t1", 100),
      usageRow("t2", 200),
      // the compaction row
      usageRow(null, 12_345),
    ];
    expect(usedTokensOf(retain(rows))).toEqual([12_345]);
  });

  it("rows AFTER the compaction row survive, per turn", () => {
    const rows = [
      usageRow("t1", 100),
      usageRow(null, 12_345),
      usageRow("t2", 13_001),
      usageRow("t2", 13_500),
    ];
    expect(usedTokensOf(retain(rows))).toEqual([12_345, 13_500]);
  });

  it("two compaction rows keep only the later one", () => {
    const rows = [usageRow("t1", 100), usageRow(null, 900), usageRow(null, 800)];
    expect(usedTokensOf(retain(rows))).toEqual([800]);
  });

  it("never drops a row the rule does not govern", () => {
    const rows = [otherRow("t1"), usageRow("t1", 100), otherRow(null), usageRow(null, 50)];
    const kept = retain(rows);
    expect(kept.filter((row) => row.kind === "message.appended").length).toBe(2);
    expect(usedTokensOf(kept)).toEqual([50]);
  });

  it("passes a malformed row through rather than letting it shadow a valid one", () => {
    const rows = [usageRow("t1", 100), usageRow("t1", "nope")];
    const kept = retain(rows);
    expect(usedTokensOf(kept)).toEqual([100, "nope"]);
  });

  it("returns the input by reference when nothing is dropped", () => {
    const rows = [usageRow("t1", 100)];
    expect(retain(rows)).toBe(rows);
  });
});

describe("projectThreadDetailSnapshot — the snapshot pruner delegates the rule", () => {
  /** The snapshot door the HTTP/WS handlers take; only `thread.activities` matters here. */
  const project = (
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ): ReadonlyArray<OrchestrationThreadActivity> =>
    projectThreadDetailSnapshot({ thread: { activities } } as never).thread.activities;

  it("a compaction row supersedes the previous turns' usage rows in the snapshot", () => {
    expect(
      usedTokensOf(
        project([usageRow("t1", 180_000), usageRow("t2", 190_000), usageRow(null, 12_345)]),
      ),
    ).toEqual([12_345]);
  });

  it("an ordinary usage row still only supersedes its OWN turn", () => {
    expect(
      usedTokensOf(
        project([usageRow("t1", 180_000), usageRow("t2", 190_000), usageRow("t2", 191_000)]),
      ),
    ).toEqual([180_000, 191_000]);
  });
});
