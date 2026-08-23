// ru-code: the boot sweep — the pure per-thread plan AND the real write path
// (engine dispatch → event store → projection) via the orchestration
// integration harness. Proves the restart contract: dangling compaction tasks
// and parked requests on qwen threads are closed with honest rows, a stale
// live-claiming session row is reset to "stopped" (which the projector turns
// into settling the running turn — restart ≡ Stop), while non-qwen threads
// keep upstream's lazy-heal behavior byte-identical.
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { makeOrchestrationIntegrationHarness } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import {
  findDanglingCompactionTaskIds,
  findDanglingParkedRequests,
  SWEEP_ACTIVITY_KINDS,
} from "../../qwen/compaction/compactionHistory.ts";
import {
  CANCELLED_APPROVAL_TEXT,
  CANCELLED_USER_INPUT_TEXT,
  INTERRUPTED_AGENT_TEXT,
  INTERRUPTED_COMPACTION_TEXT,
  makeSweepThreadStateReader,
  planQwenBootSweepRows,
  planQwenBootSweepSessionStop,
  planQwenBootSweepStreamingFinalizes,
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

  // ru-code (P2 zombie settle, boot-sweep half): the dead-process complement to
  // settleOpenSubAgentAsStopped (QwenAdapter.ts) — a hard kill (SIGKILL, power
  // loss) never runs abortSession, so only the next boot's sweep can close the
  // row. Classification reads the `agentKind` ingestion already stamped on the
  // open row (the schema-widening's whole point): a background shell/monitor/
  // compaction start must NOT be settled here.
  const AGENT_TASK_ID = "call-agent-1";
  it("closes a dangling open AGENT task with a stopped terminal row", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      makeActivity("task.started", {
        taskId: AGENT_TASK_ID,
        taskType: "subagent",
        agentKind: "agent",
      }),
    ]);
    expect(rows).toEqual([
      {
        threadId: THREAD_QWEN,
        kind: "task.completed",
        tone: "info",
        summary: INTERRUPTED_AGENT_TEXT,
        payload: { taskId: AGENT_TASK_ID, status: "stopped", detail: INTERRUPTED_AGENT_TEXT },
      },
    ]);
  });

  it("an agent whose task.started already has a terminal row needs no closing row", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      makeActivity("task.started", {
        taskId: AGENT_TASK_ID,
        taskType: "subagent",
        agentKind: "agent",
      }),
      makeActivity("task.completed", {
        taskId: AGENT_TASK_ID,
        status: "completed",
        agentKind: "agent",
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("a background shell/monitor start is NEVER settled as an agent", () => {
    const rows = planQwenBootSweepRows(THREAD_QWEN, [
      // A background shell's task.started — agentKind stamped "background".
      makeActivity("task.started", {
        taskId: "shell-1",
        taskType: "shell",
        agentKind: "background",
      }),
      // An UNSTAMPED task.started — no agentKind at all (pre-P1 or a kind the
      // sweep must not guess is an agent from taskId shape alone).
      makeActivity("task.started", { taskId: "unstamped-1", taskType: "monitor" }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe("planQwenBootSweepStreamingFinalizes", () => {
  const makeMessage = (over: Partial<OrchestrationMessage>): OrchestrationMessage => ({
    id: MessageId.make("m-1"),
    role: "assistant",
    text: "partial answer",
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:01.000Z",
    ...over,
  });

  it("finalizes only mid-stream ASSISTANT messages, carrying their turn binding", () => {
    expect(
      planQwenBootSweepStreamingFinalizes([
        makeMessage({ id: MessageId.make("m-done") }),
        makeMessage({ id: MessageId.make("m-live"), streaming: true }),
        makeMessage({ id: MessageId.make("m-user"), role: "user", streaming: true }),
        makeMessage({ id: MessageId.make("m-turnless"), streaming: true, turnId: null }),
      ]),
    ).toEqual([
      {
        messageId: MessageId.make("m-live"),
        turnId: TurnId.make("turn-1"),
        updatedAt: "2026-03-01T00:00:01.000Z",
      },
      {
        messageId: MessageId.make("m-turnless"),
        turnId: null,
        updatedAt: "2026-03-01T00:00:01.000Z",
      },
    ]);
  });

  it("a fully finalized history needs nothing", () => {
    expect(planQwenBootSweepStreamingFinalizes([makeMessage({})])).toEqual([]);
  });
});

describe("planQwenBootSweepSessionStop", () => {
  const NOW = "2026-03-01T00:00:05.000Z";
  const runningSession: OrchestrationSession = {
    threadId: THREAD_QWEN,
    status: "running",
    providerName: "qwen",
    providerInstanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("qwen")),
    runtimeMode: "approval-required",
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
  };

  it("resets a running session to the Stop handler's exact shape (activeTurnId cleared)", () => {
    expect(planQwenBootSweepSessionStop(runningSession, NOW)).toEqual({
      threadId: THREAD_QWEN,
      status: "stopped",
      providerName: "qwen",
      providerInstanceId: runningSession.providerInstanceId,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    });
  });

  it("resets every non-stopped status; an error banner is carried, not erased", () => {
    for (const status of ["starting", "ready", "error"] as const) {
      const reset = planQwenBootSweepSessionStop(
        { ...runningSession, status, lastError: "boom" },
        NOW,
      );
      expect(reset?.status).toBe("stopped");
      expect(reset?.lastError).toBe("boom");
    }
  });

  it("an honest row needs no dispatch: stopped session and missing session plan null", () => {
    expect(planQwenBootSweepSessionStop({ ...runningSession, status: "stopped" }, NOW)).toBeNull();
    expect(planQwenBootSweepSessionStop(null, NOW)).toBeNull();
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
              chatViewMode: null, // ru-code: thread-state chat view (extended chat)
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
            // A mid-stream assistant message the dead process never finalized.
            yield* harness.engine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: CommandId.make(`sweep-seed-stream-${index}`),
              threadId,
              messageId: MessageId.make(`sweep-stream-${index}`),
              delta: "partial answer…",
              turnId: TurnId.make(`sweep-turn-${index}`),
              createdAt,
            });
            // A stale live claim: the previous process died mid-turn, leaving
            // status "running" + an active turn in the projection.
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`sweep-seed-session-${index}`),
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: index === 0 ? "qwen" : "claudeAgent",
                runtimeMode: "approval-required",
                activeTurnId: TurnId.make(`sweep-turn-${index}`),
                lastError: null,
                updatedAt: createdAt,
              },
              createdAt,
            });
          }

          // The prod reader over the harness's own SqlClient + shell read —
          // the sweep below runs through the exact production read path.
          const readSweepThreadState = makeSweepThreadStateReader(
            harness.sql,
            harness.snapshotQuery.getThreadShellById,
          );

          // S5 equivalence law (the 0-regression guarantee): on both seeded
          // threads the lean reader must yield exactly the state the previous
          // full-detail read derived — same session row, same mid-stream
          // assistant messages, same kind-filtered activities — and feed the
          // pure plans to identical outputs.
          for (const threadId of [THREAD_QWEN, THREAD_OTHER]) {
            const detail = yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.messages.some((message) => message.streaming) &&
                findDanglingParkedRequests(thread.activities).length > 0 &&
                thread.session?.status === "running",
            );
            const lean = yield* readSweepThreadState(threadId);
            assert.isNotNull(lean, `lean state missing for ${threadId}`);
            assert.deepStrictEqual(lean!.session, detail.session);
            assert.deepStrictEqual(
              lean!.streamingAssistantMessages,
              detail.messages
                .filter((message) => message.role === "assistant" && message.streaming)
                .map((message) => ({
                  id: message.id,
                  role: message.role,
                  streaming: message.streaming,
                  turnId: message.turnId,
                  updatedAt: message.updatedAt,
                })),
            );
            assert.deepStrictEqual(
              lean!.activities,
              detail.activities
                .filter((activity) => SWEEP_ACTIVITY_KINDS.includes(activity.kind))
                .map((activity) => {
                  const payload = activity.payload as Record<string, unknown>;
                  return {
                    kind: activity.kind,
                    payload: {
                      ...(typeof payload["taskId"] === "string"
                        ? { taskId: payload["taskId"] }
                        : {}),
                      ...(typeof payload["requestId"] === "string"
                        ? { requestId: payload["requestId"] }
                        : {}),
                    },
                  };
                }),
            );
            assert.deepStrictEqual(
              planQwenBootSweepStreamingFinalizes(lean!.streamingAssistantMessages),
              planQwenBootSweepStreamingFinalizes(detail.messages),
            );
            assert.deepStrictEqual(
              planQwenBootSweepRows(threadId, lean!.activities),
              planQwenBootSweepRows(threadId, detail.activities),
            );
            assert.deepStrictEqual(
              planQwenBootSweepSessionStop(lean!.session, createdAt),
              planQwenBootSweepSessionStop(detail.session, createdAt),
            );
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
            readSweepThreadState,
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

          // The stale live claim is reset with the Stop handler's exact write:
          // the web derives phase "disconnected" (spinner/timer/Stop button
          // gone), and the projector settles the running turn — that fan-out
          // is the projector's own pinned contract (projector.test.ts
          // "Leaving the running session status settles the running turn").
          // Upstream 7aad7911f (#5553): a terminal session no longer erases
          // history — latestTurn STAYS, settled. The phantom-run guarantee is
          // the settled state.
          const sweptSession = yield* harness.waitForThread(
            THREAD_QWEN,
            (thread) => thread.session?.status === "stopped",
          );
          assert.strictEqual(sweptSession.session?.activeTurnId, null);
          assert.strictEqual(sweptSession.session?.lastError, null);
          assert.strictEqual(sweptSession.latestTurn?.state, "interrupted");
          assert.strictEqual(sweptSession.latestTurn?.turnId, TurnId.make("sweep-turn-0"));
          assert.isNotNull(sweptSession.latestTurn?.completedAt);

          // The mid-stream message is finalized with its text kept — the
          // timeline's turn fold (blocked by streaming:true) can now form.
          const finalized = sweptSession.messages.find(
            (message) => message.id === MessageId.make("sweep-stream-0"),
          );
          assert.isDefined(finalized, "streamed message missing");
          assert.strictEqual(finalized!.streaming, false);
          assert.strictEqual(finalized!.text, "partial answer…");
          assert.strictEqual(finalized!.turnId, TurnId.make("sweep-turn-0"));
          // Back-dated finalize: the "Worked for …" fold must end at the last
          // real delta, not at boot — updatedAt stays the seed's timestamp.
          assert.strictEqual(finalized!.updatedAt, createdAt);

          // The non-qwen thread is untouched — upstream lazy-heal preserved.
          const otherThread = yield* harness.waitForThread(THREAD_OTHER, () => true);
          assert.deepStrictEqual(findDanglingCompactionTaskIds(otherThread.activities), [TASK_ID]);
          assert.deepStrictEqual(findDanglingParkedRequests(otherThread.activities), [
            { requestId: "req-a", kind: "approval" },
          ]);
          assert.strictEqual(otherThread.session?.status, "running");
          assert.strictEqual(otherThread.session?.activeTurnId, TurnId.make("sweep-turn-1"));
          const otherStreaming = otherThread.messages.find(
            (message) => message.id === MessageId.make("sweep-stream-1"),
          );
          assert.strictEqual(otherStreaming?.streaming, true);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
