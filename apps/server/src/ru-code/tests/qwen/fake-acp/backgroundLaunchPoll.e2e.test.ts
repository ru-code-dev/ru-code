// ru-code (agentic-flow wave, P2): the born-red matrix for the LAUNCH and the
// POLL — P3a and P3b of the wave plan.
//
// Every frame the fake puts on the wire comes from the 1:1 transcription in
// `qwen021BackgroundAgents.ts`; every rule the fake applies to a poll comes from
// the same file. A fixture field with no pin there does not exist.
//
// What these specs pin, and why each is a real defect today:
//   1. A background launch must open a RUNNING row. The launch frame is a
//      TERMINAL `tool_call_update` (research §1.2), so today's classifier reads
//      it as a finished agent and closes the row the instant it opens.
//   2. The row's display fields come from `rawOutput` (structured); its ID is
//      EXTRACTED from the launch payload's fixed `task_id: <id> (` line
//      (agent.ts:3677 — RULINGS 2026-08-27 F1 = OPTION A), because the id is a
//      random suffix qwen never puts on the wire in any structured field.
//   3. No model-facing text ("task_id: … internal ID — do not mention to the
//      user") may reach any row (RULINGS 2026-08-27).
//   4. The poll is the ONLY live signal that exists (research §2.3) and must
//      run demand-driven: start on launch detection, stop when everything is
//      terminal, never poll an idle session.
//   5. A rehydrated `paused` task stays VISIBLE as a resumable row.
//   6. A poll surface that answers `-32601` (a 0.13.1 engine, which has no
//      background feature at all) must strike the poll out, not spin.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import {
  collectBackgroundEvents,
  makeBackgroundAdapter,
  runningTaskEntry,
  TEST_BACKGROUND_POLL_INTERVAL_MS,
} from "./backgroundHarness.ts";
import { FAKE_SESSION_ID } from "./fakeAcpCore.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-launch-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// ru-code (agentic-flow wave, FIX ROUND 1): `call_…` is the shape qwen's ACP layer actually mints
// for a tool call id (Session.ts:6983 `fc.id ?? generatedCallId`), and it is
// PROVABLY NOT part of the agent id — hence a task id built from an unrelated
// random-8 suffix, exactly as `agent.ts:2839`'s `randomUUID().slice(0, 8)` does.
const TOOL_CALL_ID = "call_bg1a2b3c";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
/** agent.ts:2842 — `${subagentConfig.name}-${agentIdSuffix}`, suffix random. */
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "9f2c41ab");
const SENTINEL = "BG_LAUNCH_SENTINEL";

/** The prose qwen hands the MODEL and mirrors onto the wire (agent.ts:3675-3682). */
const MODEL_FACING_FRAGMENTS = [
  "Background agent launched successfully.",
  "task_id:",
  "internal ID",
  "do not mention to the user",
  "output_file:",
];

const launchScript = (backgroundTasks?: FakeBackgroundTasksOptions): FakeAcpScript => ({
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitBackgroundLaunch({
        toolCallId: TOOL_CALL_ID,
        agentId: TASK_ID,
        subagentName: SUBAGENT_TYPE,
        taskDescription: DESCRIPTION,
      })
      .emitText(SENTINEL)
      .respondOk(),
  ...(backgroundTasks ? { backgroundTasks } : {}),
});

it.effect(
  "P3a — a background launch opens a RUNNING row with parsed fields and no leaked prose",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeBackgroundAdapter();
      const view = yield* collectBackgroundEvents(adapter);
      const threadId = ThreadId.make("qwen-bg-launch");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "launch an agent" });
      yield* view.waitFor("the sentinel reached the chat", () =>
        view.chatText().includes(SENTINEL),
      );
      yield* view.stop;

      // 1. The row EXISTS and is keyed by qwen's REAL agent id — the one and
      //    only string its registry, poll snapshot, notification `_meta` and
      //    cancel method answer to. It is NOT derivable from `toolCallId`
      //    (agent.ts:2839 falls through to `randomUUID().slice(0, 8)` on the ACP
      //    path), so the only lawful source is the launch payload's `task_id:`
      //    line (agent.ts:3677) — RULINGS 2026-08-27 F1 = OPTION A.
      const started = view.taskStarted();
      assert.lengthOf(started, 1, "a background launch must open exactly one task row");
      assert.strictEqual(started[0]!.payload.taskId, TASK_ID);
      assert.notInclude(
        started[0]!.payload.taskId,
        TOOL_CALL_ID,
        "the task id must not be reconstructed from the wire toolCallId (F1)",
      );
      assert.strictEqual(started[0]!.payload.toolUseId, TOOL_CALL_ID);
      assert.strictEqual(started[0]!.payload.taskType, "subagent");
      assert.strictEqual(started[0]!.payload.title, DESCRIPTION);
      assert.strictEqual(started[0]!.payload.role, SUBAGENT_TYPE);

      // 2. It stays RUNNING — the launch frame's terminal wire status is a lie.
      assert.lengthOf(
        view.taskCompleted(),
        0,
        "the lying launch frame must not settle the row (research §1.2)",
      );

      // 3. Not one byte of the model-facing launch prose reaches any surface.
      //    Collected field-by-field rather than by serialising the events: the
      //    raw ACP payload rides along on item events by design (it is the wire
      //    record, not a rendered field), so a whole-object scan would flag the
      //    frame we are deliberately carrying.
      const renderedStrings = view.events.flatMap((event) => {
        const payload = event.payload as Record<string, unknown>;
        return Object.values(payload).filter((value): value is string => typeof value === "string");
      });
      for (const fragment of MODEL_FACING_FRAGMENTS) {
        const leak = renderedStrings.find((value) => value.includes(fragment));
        assert.isUndefined(leak, `model-facing launch prose leaked: ${fragment}`);
      }
    }).pipe(
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(launchScript()), testServices)),
      TestClock.withLive,
    ),
);

it.live("P3b — the poll drives the row from running to its terminal, then stops", () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  let polls = 0;
  const backgroundTasks: FakeBackgroundTasksOptions = {
    entries,
    onPoll: () => {
      polls += 1;
    },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-poll");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });

    // The poll is DEMAND-DRIVEN: it starts because a launch was detected.
    yield* view.waitFor("the poll started on launch detection", () => polls >= 1);

    // Live progress: qwen's own recentActivities are the only live signal there
    // is (research §2.3), and they must reach the row.
    entries[0] = {
      ...entries[0]!,
      recentActivities: [{ name: "read_file", description: "/a.ts", at: 1_699_999_100_000 }],
      stats: { totalTokens: 1200, toolUses: 3, durationMs: 4200 },
    };
    yield* view.waitFor("a live tool line for the background task", () =>
      view
        .taskProgress()
        .some(
          (event) =>
            event.payload.taskId === TASK_ID && (event.payload.lastToolName ?? "") === "read_file",
        ),
    );
    const progress = view.taskProgress().filter((event) => event.payload.taskId === TASK_ID);
    assert.isTrue(
      progress.some((event) => event.payload.status === "running"),
      "the poll must report the task as running",
    );
    assert.isTrue(
      progress.some((event) => (event.payload.lastToolName ?? "") === "read_file"),
      "the poll must surface qwen's recentActivities as the row's tool line",
    );

    // Terminal: the registry flips, and the row settles with usage.
    entries[0] = {
      ...entries[0]!,
      status: "completed",
      endTime: 1_699_999_200_000,
      notified: true,
      stats: { totalTokens: 2400, toolUses: 5, durationMs: 9000 },
    };
    yield* view.waitFor("the row settled from the poll", () =>
      view.taskCompleted().some((event) => event.payload.taskId === TASK_ID),
    );
    const completed = view.taskCompleted().find((event) => event.payload.taskId === TASK_ID)!;
    assert.strictEqual(completed.payload.status, "completed");
    assert.strictEqual(completed.payload.typedUsage?.totalTokens, 2400);
    assert.strictEqual(completed.payload.typedUsage?.toolUses, 5);

    // The poll STOPS once nothing is left to watch — never polls an idle session.
    //
    // Measured over MANY ticks, not one: a window shorter than the cadence
    // cannot tell a stopped poll from a slow one, and a spec that cannot tell
    // them apart passes whether or not the stop exists (found by mutation M11).
    // The chat fallback is allowed its one grace tick before the count freezes.
    yield* Effect.sleep(`${TEST_BACKGROUND_POLL_INTERVAL_MS * 3} millis`);
    const pollsAtSettle = polls;
    yield* Effect.sleep(`${TEST_BACKGROUND_POLL_INTERVAL_MS * 8} millis`);
    assert.strictEqual(
      polls,
      pollsAtSettle,
      "the poll must stop once every task is terminal (RULINGS 2026-08-27)",
    );
    yield* view.stop;
  }).pipe(
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(launchScript(backgroundTasks)), testServices),
    ),
  );
});

it.live("P3b — a rehydrated paused task stays visible as a resumable row", () => {
  const entries: QwenAgentTaskEntry[] = [
    {
      ...runningTaskEntry({ id: TASK_ID, description: DESCRIPTION, subagentType: SUBAGENT_TYPE }),
      status: "paused",
    },
  ];
  const backgroundTasks: FakeBackgroundTasksOptions = { entries };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-paused");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });

    // `paused` is qwen's crash-recovery state (research §15.1). Our shared
    // vocabulary calls that `idle` — the mapping ClaudeAdapter.ts:993 already
    // uses — and the row must NOT disappear or settle.
    yield* view.waitFor("the paused task reached the roster as idle", () =>
      [...view.taskProgress(), ...view.taskUpdated()].some(
        (event) => event.payload.taskId === TASK_ID && event.payload.status === "idle",
      ),
    );
    assert.lengthOf(
      view.taskCompleted().filter((event) => event.payload.taskId === TASK_ID),
      0,
      "a paused task is not finished — it must never settle",
    );

    // Resume is MODEL-driven (research §15.2): when qwen flips it back, the poll
    // shows running again on the SAME id (ids are immutable, §15.3).
    entries[0] = { ...entries[0]!, status: "running" };
    yield* view.waitFor("the resumed task reads running on the same id", () =>
      view
        .taskProgress()
        .some((event) => event.payload.taskId === TASK_ID && event.payload.status === "running"),
    );
    yield* view.stop;
  }).pipe(
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(launchScript(backgroundTasks)), testServices),
    ),
  );
});

it.live(
  "P3e — session/load rehydrates paused tasks into rows, probed on the resolved response",
  () => {
    // What qwen leaves behind after a crash: the sidecar said `running`, so the
    // restore re-registers it as `paused` (background-agent-resume.ts:545) —
    // BEFORE the load response returns (acpAgent.ts:4523), which is what makes
    // probing on the resolved response race-free (research §15.1).
    const REHYDRATED = qwenBackgroundAgentId(SUBAGENT_TYPE, "dead5e55");
    const entries: QwenAgentTaskEntry[] = [
      {
        ...runningTaskEntry({
          id: REHYDRATED,
          description: "Survey the repo",
          subagentType: SUBAGENT_TYPE,
        }),
        status: "paused",
      },
    ];
    const loaded: string[] = [];
    const script: FakeAcpScript = {
      dialect: "v2",
      onPrompt: (steps) => steps.emitText(SENTINEL).respondOk(),
      onLoadSession: (sessionId) => {
        loaded.push(sessionId);
      },
      backgroundTasks: { entries },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeBackgroundAdapter();
      const view = yield* collectBackgroundEvents(adapter);
      const threadId = ThreadId.make("qwen-bg-resume");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        // The persisted cursor our own resume path round-trips (readiness §3.4).
        resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
      });
      assert.deepStrictEqual(loaded, [FAKE_SESSION_ID], "the session must resume by session/load");

      // The row exists WITHOUT any launch frame in this session — adopted from
      // the probe, keyed by the immutable agent id (research §15.3).
      yield* view.waitFor("the rehydrated task got a row", () =>
        view.taskStarted().some((event) => event.payload.taskId === REHYDRATED),
      );
      yield* view.waitFor("the rehydrated task reads as resumable", () =>
        [...view.taskProgress(), ...view.taskUpdated()].some(
          (event) => event.payload.taskId === REHYDRATED && event.payload.status === "idle",
        ),
      );

      // Resume is MODEL-driven (§15.2) and the poll shows it instantly (§15.4).
      entries[0] = { ...entries[0]!, status: "running" };
      yield* view.waitFor("the resumed task reads running on the same id", () =>
        view
          .taskProgress()
          .some(
            (event) => event.payload.taskId === REHYDRATED && event.payload.status === "running",
          ),
      );
      yield* view.stop;
    }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
  },
);

it.live("P3b — a poll surface that answers -32601 strikes the poll out instead of spinning", () => {
  let polls = 0;
  const backgroundTasks: FakeBackgroundTasksOptions = {
    entries: [
      runningTaskEntry({ id: TASK_ID, description: DESCRIPTION, subagentType: SUBAGENT_TYPE }),
    ],
    onPollAttempt: () => {
      polls += 1;
    },
    // A 0.13.1 engine has no background feature at all (research §5), so its
    // ext-method surface rejects every one of these calls, forever.
    pollFailures: [
      { code: -32601, message: "Method not found: qwen/status/session/tasks" },
      { code: -32601, message: "Method not found: qwen/status/session/tasks" },
      { code: -32601, message: "Method not found: qwen/status/session/tasks" },
      { code: -32601, message: "Method not found: qwen/status/session/tasks" },
      { code: -32601, message: "Method not found: qwen/status/session/tasks" },
    ],
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-strikeout");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the poll was attempted", () => polls >= 1);
    yield* Effect.sleep(`${TEST_BACKGROUND_POLL_INTERVAL_MS * 8} millis`);
    // EXACTLY one. A missing method can never start existing mid-session, so it
    // is a PERMANENT latch, not a three-strike count — and asserting "at most
    // three" could not tell the two apart, which is why it passed under its own
    // mutation (M8) before this line was sharpened.
    assert.strictEqual(polls, 1, "a method-not-found poll must latch off after ONE attempt");
    // Struck out is not the same as finished: nothing may fabricate a terminal.
    assert.lengthOf(
      view.taskCompleted().filter((event) => event.payload.taskId === TASK_ID),
      0,
      "a struck-out poll must never invent a terminal for a task it cannot see",
    );
    yield* view.stop;
  }).pipe(
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(launchScript(backgroundTasks)), testServices),
    ),
  );
});
