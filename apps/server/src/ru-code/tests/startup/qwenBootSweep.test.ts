// ru-code: the boot sweep — the pure per-thread plan AND the real write path
// (engine dispatch → event store → projection) via the orchestration
// integration harness. Proves the restart contract: dangling compaction tasks
// and parked requests on qwen threads are closed with honest rows, while
// non-qwen threads keep upstream's lazy-heal behavior byte-identical.
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { makeOrchestrationIntegrationHarness } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import {
  findDanglingCompactionTaskIds,
  findDanglingParkedRequests,
} from "../../qwen/compaction/compactionHistory.ts";
import {
  CANCELLED_APPROVAL_TEXT,
  CANCELLED_USER_INPUT_TEXT,
  INTERRUPTED_COMPACTION_TEXT,
  planQwenBootSweepRows,
  runQwenBootSweepWith,
} from "../../startup/qwenBootSweep.ts";

const THREAD_QWEN = ThreadId.make("boot-sweep-qwen-thread");
const THREAD_OTHER = ThreadId.make("boot-sweep-other-thread");
const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}sweep-1`;

let nextActivityId = 0;
const makeActivity = (
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(`seed-${nextActivityId++}`),
  createdAt: "2026-03-01T00:00:00.000Z",
  kind,
  summary: kind,
  tone: "info",
  payload,
  turnId: null,
});

describe("planQwenBootSweepRows", () => {
  it("closes a dangling compaction with the morphing row's terminal shape", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      makeActivity("task.progress", { taskId: TASK_ID, detail: "Compacting context…" }),
    ]);
    expect(rows).toEqual([
      {
        threadId: THREAD_QWEN,
        kind: "task.completed",
        tone: "info",
        summary: INTERRUPTED_COMPACTION_TEXT,
        payload: { taskId: TASK_ID, status: "stopped", detail: INTERRUPTED_COMPACTION_TEXT },
      },
    ]);
  });

  it("cancels dangling parked requests with the kinds the pending panels treat as terminal", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      makeActivity("approval.requested", { requestId: "req-a", requestKind: "command" }),
      makeActivity("user-input.requested", { requestId: "req-q", questions: [] }),
    ]);
    expect(rows).toEqual([
      {
        threadId: THREAD_QWEN,
        kind: "approval.resolved",
        tone: "info",
        summary: CANCELLED_APPROVAL_TEXT,
        payload: { requestId: "req-a" },
      },
      {
        threadId: THREAD_QWEN,
        kind: "user-input.resolved",
        tone: "info",
        summary: CANCELLED_USER_INPUT_TEXT,
        payload: { requestId: "req-q" },
      },
    ]);
  });

  it("a fully-closed history needs no rows", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      makeActivity("task.progress", { taskId: TASK_ID }),
      makeActivity("task.completed", { taskId: TASK_ID, status: "completed" }),
      makeActivity("approval.requested", { requestId: "req-a", requestKind: "command" }),
      makeActivity("approval.resolved", { requestId: "req-a" }),
    ]);
    expect(rows).toEqual([]);
  });
});

const QWEN = ProviderDriverKind.make("qwen");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

// it.live: the harness polls with real sleeps (same as the error-pipeline e2e).
it.live(
  "integration: sweeps qwen threads through the real engine, leaves other providers alone",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness(),
      (harness) =>
        Effect.gen(function* () {
          const createdAt = "2026-03-01T00:00:00.000Z";
          const projectId = ProjectId.make("boot-sweep-project");
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("sweep-project-create"),
            projectId,
            title: "Boot Sweep Project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: { instanceId: defaultInstanceIdForDriver(QWEN), model: "m" },
            createdAt,
          });

          // Two identical threads with dangling work; only the qwen-bound one
          // must be swept.
          for (const [index, threadId] of [THREAD_QWEN, THREAD_OTHER].entries()) {
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`sweep-thread-create-${index}`),
              threadId,
              projectId,
              title: `Boot Sweep Thread ${index}`,
              modelSelection: { instanceId: defaultInstanceIdForDriver(QWEN), model: "m" },
              interactionMode: "default",
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: harness.workspaceDir,
              createdAt,
            });
            const danglingRows: ReadonlyArray<OrchestrationThreadActivity> = [
              makeActivity("task.progress", { taskId: TASK_ID, detail: "Compacting context…" }),
              makeActivity("approval.requested", { requestId: "req-a", requestKind: "command" }),
            ];
            for (const [rowIndex, activity] of danglingRows.entries()) {
              yield* harness.engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`sweep-seed-${index}-${rowIndex}`),
                threadId,
                activity,
                createdAt,
              });
            }
          }

          let uuidCounter = 0;
          yield* runQwenBootSweepWith({
            listBindings: () =>
              Effect.succeed([
                { threadId: THREAD_QWEN, provider: QWEN, lastSeenAt: createdAt },
                { threadId: THREAD_OTHER, provider: CLAUDE, lastSeenAt: createdAt },
                // A binding whose thread no longer exists must be skipped, not fail.
                {
                  threadId: ThreadId.make("boot-sweep-missing"),
                  provider: QWEN,
                  lastSeenAt: createdAt,
                },
              ]),
            getThreadDetailById: harness.snapshotQuery.getThreadDetailById,
            dispatch: harness.engine.dispatch,
            randomUuid: Effect.sync(() => `sweep-uuid-${uuidCounter++}`),
          });

          // The qwen thread converges: nothing dangles, exact closing rows landed.
          const sweptThread = yield* harness.waitForThread(
            THREAD_QWEN,
            (thread) => findDanglingCompactionTaskIds(thread.activities).length === 0,
          );
          assert.deepStrictEqual(findDanglingParkedRequests(sweptThread.activities), []);
          const closedTask = sweptThread.activities.find(
            (activity) =>
              activity.kind === "task.completed" &&
              activity.summary === INTERRUPTED_COMPACTION_TEXT,
          );
          assert.isDefined(closedTask, "no compaction closing row");
          assert.deepStrictEqual(closedTask!.payload, {
            taskId: TASK_ID,
            status: "stopped",
            detail: INTERRUPTED_COMPACTION_TEXT,
          });
          const cancelledApproval = sweptThread.activities.find(
            (activity) => activity.kind === "approval.resolved",
          );
          assert.isDefined(cancelledApproval, "no approval closing row");
          assert.strictEqual(cancelledApproval!.summary, CANCELLED_APPROVAL_TEXT);

          // The non-qwen thread is untouched — upstream lazy-heal preserved.
          const otherThread = yield* harness.waitForThread(THREAD_OTHER, () => true);
          assert.deepStrictEqual(findDanglingCompactionTaskIds(otherThread.activities), [TASK_ID]);
          assert.deepStrictEqual(findDanglingParkedRequests(otherThread.activities), [
            { requestId: "req-a", kind: "approval" },
          ]);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
