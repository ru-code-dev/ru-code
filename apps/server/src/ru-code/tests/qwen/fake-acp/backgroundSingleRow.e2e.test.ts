// ru-code (agentic-flow wave, FIX ROUND 1): ONE ROW PER BACKGROUND AGENT, and
// that row always has a NAME.
//
// The defect these specs exist for (owner live smoke against real qwen 0.21.1,
// verifier F1, RULINGS 2026-08-27 F1 = OPTION A): the host reconstructed the
// task id as `${subagentName}-${toolCallId}`, which is NOT the id qwen uses.
// `agent.ts:2839` reads `this.callId ?? randomUUID().slice(0, 8)`, and on the
// ACP path `this.callId` is never set — `Session.runTool` calls `setCallId` only
// under `if (policyToolName === ToolNames.MONITOR)` (`Session.ts:7181-7185`),
// and ACP routes through that function (`Session.ts:7353`: "duplicated from
// coreToolScheduler.ts; ACP routes through this Session path"). So every
// producer that speaks qwen's REAL id — poll snapshots, the notification
// pseudo-turn's `_meta.backgroundTask.taskId`, the post-load probe, the cancel
// method — addressed a different row than the launch had opened. The observable
// result was a launch row frozen at "Working" forever plus a second row per
// agent, and a row whose title had fallen back to its own id.
//
// Every row identity here is a MAP KEY: `foldSubagentActivities` does
// `getOrCreate(agents, taskId, …)` for `task.started`/`task.progress`/
// `task.updated`/`task.completed` alike (subagentRuntime.ts:554-692), so
// "how many distinct `taskId`s did the producers emit" IS "how many cards the
// panel shows". A row's name is `asString(payload.title) ?? asString(payload.detail) ?? id`
// (subagentRuntime.ts:362), so a payload with no title is a card titled with an
// id — which is why every producer is checked for one here, not just the launch.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../config.ts";
import {
  collectBackgroundEvents,
  collectNativeLog,
  makeBackgroundAdapter,
  runningTaskEntry,
  type BackgroundEventView,
} from "./backgroundHarness.ts";
import { FAKE_SESSION_ID } from "./fakeAcpCore.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import {
  qwenBackgroundAgentId,
  qwenBackgroundLaunchResultDisplay,
  type QwenAgentTaskEntry,
} from "./qwen021BackgroundAgents.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-onerow-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** The wire tool call id (`Session.ts:6983` → `fc.id ?? generatedCallId`). */
const TOOL_CALL_ID = "call_1a2b3c4d";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
/** qwen's REAL registry id — `agent.ts:2842`, random suffix (`:2839`). */
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "5e6f7a8b");
const TURN_TEXT = "the parent's own reply";

type OutOfBand = Parameters<NonNullable<FakeAcpScript["onOutOfBandEmitter"]>>[0];

/** Every `task.*` event this wave can emit, grouped by kind. */
const taskEvents = (view: BackgroundEventView) => [
  ...view.taskStarted(),
  ...view.taskProgress(),
  ...view.taskUpdated(),
  ...view.taskCompleted(),
];

const distinctTaskIds = (events: ReadonlyArray<{ readonly payload: { taskId: string } }>) => [
  ...new Set(events.map((event) => event.payload.taskId)),
];

it.live("FIX1 — every producer addresses ONE row, keyed by qwen's real agent id", () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const outOfBand: { current: OutOfBand | undefined } = { current: undefined };
  const backgroundTasks: FakeBackgroundTasksOptions = { entries };
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitBackgroundLaunch({
          toolCallId: TOOL_CALL_ID,
          agentId: TASK_ID,
          subagentName: SUBAGENT_TYPE,
          taskDescription: DESCRIPTION,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
    onOutOfBandEmitter: (emit) => {
      outOfBand.current = emit;
    },
    backgroundTasks,
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-one-row");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });

    // 1. THE LAUNCH — one row, keyed by the id qwen put in its own launch prose.
    yield* view.waitFor("the launch opened a row", () => view.taskStarted().length > 0);
    const started = view.taskStarted();
    assert.lengthOf(started, 1, "a launch must open exactly ONE row");
    assert.strictEqual(started[0]!.payload.taskId, TASK_ID);
    assert.isTrue(started[0]!.payload.isBackgrounded, "the stop button reads this field");

    // 2. THE POLL — progress lands on the SAME row, not on a second one.
    entries[0] = {
      ...entries[0]!,
      recentActivities: [{ name: "read_file", description: "/a.ts", at: 1_699_999_100_000 }],
    };
    yield* view.waitFor("a poll progress row arrived", () => view.taskProgress().length > 0);

    // 3. THE PUSH — qwen's pseudo-turn speaks the real id in `_meta`.
    const emit = outOfBand.current!;
    yield* emit.backgroundNotificationDisplay({
      taskId: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      status: "completed",
      toolUseId: TOOL_CALL_ID,
    });
    yield* emit.backgroundEndTurn("end_turn");

    // 4. THE TERMINAL — from the poll (the row settles from the snapshot, never
    //    from the caller: D-P3e-1).
    entries[0] = {
      ...entries[0]!,
      status: "completed",
      endTime: 1_699_999_200_000,
      notified: true,
      stats: { totalTokens: 2400, toolUses: 5, durationMs: 9000 },
    };
    yield* view.waitFor("the row settled", () => view.taskCompleted().length > 0);

    const all = taskEvents(view);
    assert.deepStrictEqual(
      distinctTaskIds(all),
      [TASK_ID],
      "every producer must address ONE row keyed by qwen's real agent id",
    );
    // The id must not be derivable from the wire tool call id — the whole point
    // of F1. Stated as its own assertion so a regression names itself.
    assert.notInclude(TASK_ID, TOOL_CALL_ID);
    assert.lengthOf(view.taskStarted(), 1, "no second row may be opened for the same agent");
    assert.lengthOf(view.taskCompleted(), 1, "a row settles exactly once");

    // The lifecycle the panel renders: running while live, then completed. The
    // stop button's predicate (`isBackgrounded && isActiveSubagentStatus`,
    // AgentStopButton.tsx:29) is fed by exactly these two facts.
    assert.isTrue(
      view.taskProgress().some((event) => event.payload.status === "running"),
      "a live background row must read running",
    );
    assert.strictEqual(view.taskCompleted()[0]!.payload.status, "completed");
    assert.isTrue(
      view.taskCompleted()[0]!.payload.isBackgrounded,
      "the terminal row stays a background row — the card stays, the button goes",
    );

    // 5. THE TITLE CHAIN — no producer may leave the row to be named by its id.
    for (const event of all) {
      const title = (event.payload as { readonly title?: string }).title;
      assert.isDefined(title, `${event.type} left the row unnamed (it would be titled by its id)`);
      assert.notStrictEqual(title, TASK_ID, `${event.type} titled the row with its own id`);
      assert.strictEqual(title, DESCRIPTION, `${event.type} must carry qwen's own description`);
    }
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX2 — the PREPARING frame opens no row, so no card is ever named by a call id", () => {
  // THE ZOMBIE, named. A real spawn's first frame is the preparing frame
  // (tool-call-preparation-tracker.ts:29-51): `rawInput: {}`, no description, no
  // subagent_type, and DISCARDABLE (tool-call-emitter.ts:135-156). Opening an
  // agent row from it produces a row that
  //   · is keyed by the WIRE tool call id, which no poll snapshot, no
  //     notification `_meta` and no cancel call will ever address, so nothing
  //     can settle it — the owner's immortal "running" rows; and
  //   · has no title, so `asString(payload.title) ?? asString(payload.detail) ?? id`
  //     (subagentRuntime.ts:362) names the card `call_…` — the owner's titles.
  // Both are asserted here against the wire id itself, so a regression names its
  // own mechanism instead of only moving a count.
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitBackgroundLaunch({
          toolCallId: TOOL_CALL_ID,
          agentId: TASK_ID,
          subagentName: SUBAGENT_TYPE,
          taskDescription: DESCRIPTION,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
    backgroundTasks: { entries },
  };
  const native = collectNativeLog();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter({ nativeEventLogger: native.logger });
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-preparing");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    // THE FIXTURE'S OWN BYTES, asserted off the native ACP log — every
    // `session/update` reaches it verbatim (`QwenAdapter`'s `logNative`).
    //
    // Without this the spec was DECORATIVE and the mutation battery said so:
    // deleting the fake's preparing-frame emission left every assertion below
    // passing, because they all test an ABSENCE that holds even more easily when
    // the frame was never sent. A fixture-fidelity claim has to be asserted
    // positively or it guards nothing. Each field is a `mapping-table.md §4b`
    // row; the pins live there and on `qwenEmitAgentPreparingStart`.
    const preparing = native.written.find((entry) => {
      const update = (entry.payload as { readonly update?: Record<string, unknown> })?.update;
      return (
        update?.["sessionUpdate"] === "tool_call" &&
        update?.["toolCallId"] === TOOL_CALL_ID &&
        (update?.["_meta"] as Record<string, unknown> | undefined)?.["phase"] === "preparing"
      );
    });
    assert.isDefined(preparing, "the fake must emit qwen's PREPARING frame before the launch");
    const preparingUpdate = (preparing!.payload as { readonly update: Record<string, unknown> })
      .update;
    assert.deepStrictEqual(
      preparingUpdate["rawInput"],
      {},
      "prep-tracker.ts:41 sends `args: {}` — the byte that makes the row unnameable",
    );
    assert.strictEqual(preparingUpdate["status"], "pending", "prep-tracker.ts:42");
    assert.strictEqual(preparingUpdate["title"], "Agent", "tool-names.ts:89, via the build throw");
    assert.strictEqual(preparingUpdate["kind"], "other", "tool-call-emitter.ts:50");
    assert.strictEqual(
      (preparingUpdate["_meta"] as Record<string, unknown>)["toolName"],
      "agent",
      "without this the frame is not an agent frame at all",
    );

    const all = taskEvents(view);
    assert.notInclude(
      distinctTaskIds(all),
      TOOL_CALL_ID,
      "the preparing frame must never open a row keyed by the wire tool call id",
    );
    for (const event of all) {
      const title = (event.payload as { readonly title?: string }).title;
      assert.notStrictEqual(title, TOOL_CALL_ID, `${event.type} named a card after a call id`);
      assert.notStrictEqual(
        title,
        event.payload.taskId,
        `${event.type} named a card after its own id`,
      );
    }
    assert.lengthOf(view.taskStarted(), 1, "one agent is one row, across the whole sequence");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX3 — a DISCARDED preparation leaves no row and no ghost card", () => {
  // ru-code (agentic-flow wave, FIX ROUND 3, F-A1): THIS SPEC WAS BLIND.
  //
  // It drove the right frame and then asserted only `taskStarted().length === 0`
  // — and the ghost is born from `task.**completed**`, which that assertion
  // cannot see. The adversary's PROBE A emitted, on the unfixed tree:
  //   `task.completed {taskId:"call_1a2b3c4d", status:"failed", taskType:"subagent"}`
  // with no `title` and no `detail`, and `foldSubagentActivities` calls
  // `getOrCreate` for `task.completed` exactly as it does for `task.started`
  // (subagentRuntime.ts:554-692), naming the card
  // `asString(title) ?? asString(detail) ?? id` (`:362`) — a permanent red
  // "failed" card titled `call_1a2b3c4d` for an agent that never existed.
  //
  // It also sent a HAND-ROLLED plain failed update. The real frame carries
  // `_meta.phase:'preparing'` + `preparationDiscarded:true` + `content: []`
  // (tool-call-emitter.ts:143-155) — the bytes the classifier now reads — so the
  // fixture is the builder's own output, not a lookalike.
  //
  // Asserted here as the FULL ROW-SET SHAPE: not one count, but zero `task.*`
  // of any kind, and no agent item event either. qwen's semantics say the call
  // never happened (`ToolCallPreparationTracker` holds only calls that have not
  // reached execution, `:18-22`, and `finalizeToolCallPreparations` runs in the
  // model stream's `finally`, `Session.ts:3062-3070`), so the only correct
  // number of rows, cards, titles and terminals is zero.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentPreparingStart(TOOL_CALL_ID)
        .emitAgentPreparationDiscarded(TOOL_CALL_ID)
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  const native = collectNativeLog();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter({ nativeEventLogger: native.logger });
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-discarded");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    // FIXTURE FIDELITY — the discard's own bytes, off the native ACP log. Without
    // this the assertions below are absences that hold even better when the
    // frame was never sent (the M28 lesson).
    const discarded = native.written.find((entry) => {
      const update = (entry.payload as { readonly update?: Record<string, unknown> })?.update;
      const meta = update?.["_meta"] as Record<string, unknown> | undefined;
      return update?.["sessionUpdate"] === "tool_call_update" && meta?.["phase"] === "preparing";
    });
    assert.isDefined(discarded, "the fake must emit qwen's real discard frame");
    const update = (discarded!.payload as { readonly update: Record<string, unknown> }).update;
    assert.strictEqual(update["toolCallId"], TOOL_CALL_ID);
    assert.strictEqual(update["status"], "failed", "tool-call-emitter.ts:146");
    assert.deepStrictEqual(update["content"], [], "tool-call-emitter.ts:147");
    const meta = update["_meta"] as Record<string, unknown>;
    assert.strictEqual(meta["preparationDiscarded"], true, "tool-call-emitter.ts:151");
    assert.strictEqual(meta["toolName"], "agent", "without this it is not an agent frame at all");

    // THE ROW SET — every kind, not just `task.started`.
    assert.deepStrictEqual(
      taskEvents(view).map((event) => `${event.type}:${event.payload.taskId}`),
      [],
      "a discarded preparation is not an agent — it must produce no task row at all",
    );
    // …and no timeline item for a call that never ran, either.
    assert.lengthOf(
      view.itemEvents().filter((event) => String(event.itemId).includes(TOOL_CALL_ID)),
      0,
      "a call that never happened must leave no tool item behind",
    );
    // The parent's own turn is untouched.
    assert.strictEqual(view.chatText(), TURN_TEXT);
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX3 — a RETRY after a discard still produces the agent's one real row", () => {
  // The other half of qwen's semantics: `discard` clears the tracker (`:68-70`)
  // and each model stream owns its own instance (`:11-15`), so a retried stream
  // observes the SAME callId again and the call really runs. A host that
  // tombstoned the id on the discard would drop every frame of the real run
  // (`isQwenSettledAgentFrame` → dropped), so the discard must poison nothing.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentPreparingStart(TOOL_CALL_ID)
        .emitAgentPreparationDiscarded(TOOL_CALL_ID)
        .emitAgentPreparingStart(TOOL_CALL_ID)
        .emitToolCall({
          toolCallId: TOOL_CALL_ID,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: {
            description: DESCRIPTION,
            prompt: "do the work",
            subagent_type: SUBAGENT_TYPE,
            run_in_background: false,
          },
        })
        .emitToolCallUpdate({
          toolCallId: TOOL_CALL_ID,
          toolName: "agent",
          status: "completed",
          text: "done",
          rawOutput: {
            type: "task_execution",
            subagentName: SUBAGENT_TYPE,
            taskDescription: DESCRIPTION,
            status: "completed",
            result: "done",
          },
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-discard-retry");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the retried spawn settled", () => view.taskCompleted().length > 0);
    yield* view.stop;

    assert.deepStrictEqual(distinctTaskIds(taskEvents(view)), [TOOL_CALL_ID]);
    assert.lengthOf(view.taskStarted(), 1, "the retried run must open exactly one row");
    assert.strictEqual(view.taskStarted()[0]!.payload.title, DESCRIPTION);
    assert.lengthOf(view.taskCompleted(), 1);
    assert.strictEqual(view.taskCompleted()[0]!.payload.status, "completed");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX2 — a teardown between the preparing frame and the launch leaves no row", () => {
  // The window the mandate names: the session dies after qwen announced a call
  // it had not yet parsed. Teardown settles every LIVE agent row as stopped
  // (D-P3e / the teardown sweep), so a provisional row opened by the preparing
  // frame would either be settled as an agent run that never existed, or — if it
  // were not live-tracked — hang at "running" for the rest of the thread's life.
  // With no row opened there is nothing to settle and nothing to leak.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps.emitAgentPreparingStart(TOOL_CALL_ID).emitText(TURN_TEXT).respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-teardown-window");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* adapter.stopSession(threadId).pipe(Effect.timeout("10 seconds"));
    yield* view.stop;
    assert.lengthOf(taskEvents(view), 0, "a teardown mid-preparation must leave no row at all");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX2 — the FOREGROUND spawn sequence still opens exactly one named row", () => {
  // The other half of the same wire. A foreground agent is `run_in_background:
  // false` (agent.ts:2526-2536 — the resolution qwen designates as the source of
  // truth for background classification, and which its own two UI classifiers
  // replicate from args), and its spawn is the SAME three-frame sequence:
  // preparing → the real-args opening frame → the terminal. Exactly one row,
  // named from the args, settled by the terminal — no zombie, no rename.
  const FG_CALL = "call_fg9z8y7x";
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentPreparingStart(FG_CALL)
        .emitToolCall({
          toolCallId: FG_CALL,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: {
            description: DESCRIPTION,
            prompt: "do the work",
            subagent_type: SUBAGENT_TYPE,
            run_in_background: false,
          },
        })
        .emitToolCallUpdate({
          toolCallId: FG_CALL,
          toolName: "agent",
          status: "completed",
          text: "done",
          rawOutput: {
            type: "task_execution",
            subagentName: SUBAGENT_TYPE,
            taskDescription: DESCRIPTION,
            taskPrompt: "do the work",
            status: "completed",
            result: "done",
          },
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-fg-one-row");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the foreground row settled", () => view.taskCompleted().length > 0);
    yield* view.stop;

    assert.deepStrictEqual(
      distinctTaskIds(taskEvents(view)),
      [FG_CALL],
      "a foreground agent is keyed by its tool call id, and by exactly one",
    );
    assert.lengthOf(view.taskStarted(), 1, "the preparing frame must not open a second row");
    assert.strictEqual(view.taskStarted()[0]!.payload.title, DESCRIPTION);
    assert.notStrictEqual(
      view.taskStarted()[0]!.payload.title,
      FG_CALL,
      "a foreground row must never be named after its call id either",
    );
    assert.isNotTrue(
      (view.taskStarted()[0]!.payload as { readonly isBackgrounded?: boolean }).isBackgrounded,
      "an explicit run_in_background:false agent is a FOREGROUND row",
    );
    assert.strictEqual(view.taskCompleted()[0]!.payload.status, "completed");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX2 — a FORK that detaches settles its provisional row instead of freezing it", () => {
  // THE ONE CASE QWEN CALLS UNDECIDABLE FROM ARGS, and the honest bound on the
  // one-row guarantee.
  //
  // `toolClassification.ts:44-48`, qwen's own words: "Args alone cannot
  // distinguish an interactive detached fork from a headless registry-backed
  // fork. Keep the omitted-flag shape out of this heuristic and trust
  // rawOutput.status for the effective runtime mode." So a fork whose opening
  // frame omits `run_in_background` classifies FOREGROUND — a row opens — and
  // the launch update may still announce a detached run.
  //
  // What this pins: the provisional row is SETTLED (status stopped, its card
  // intact and named) rather than left running forever, and the detached run
  // gets its own row under qwen's real id. Two cards for one fork is a stated
  // residual of qwen's own ambiguity, NOT a zombie: nothing here can hang.
  const FORK_CALL = "call_fork77";
  const FORK_TASK = qwenBackgroundAgentId("fork", "ab12cd34");
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: FORK_TASK,
      description: DESCRIPTION,
      subagentType: "fork",
      toolUseId: FORK_CALL,
    }),
  ];
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitToolCall({
          toolCallId: FORK_CALL,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: { description: DESCRIPTION, prompt: "do the work", subagent_type: "fork" },
        })
        .emitBackgroundLaunch({
          toolCallId: FORK_CALL,
          agentId: FORK_TASK,
          subagentName: "fork",
          taskDescription: DESCRIPTION,
          preparing: false,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
    backgroundTasks: { entries },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-fork");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "fork yourself" });
    yield* view.waitFor("the provisional fork row was settled", () =>
      view.taskCompleted().some((event) => event.payload.taskId === FORK_CALL),
    );
    yield* view.waitFor("the detached run opened its own row", () =>
      view.taskStarted().some((event) => event.payload.taskId === FORK_TASK),
    );
    yield* view.stop;

    const settled = view.taskCompleted().find((event) => event.payload.taskId === FORK_CALL)!;
    assert.strictEqual(settled.payload.status, "stopped", "a provisional row must never hang");
    assert.strictEqual(settled.payload.title, DESCRIPTION, "the settled card keeps its name");
    const detached = view.taskStarted().find((event) => event.payload.taskId === FORK_TASK)!;
    assert.isTrue(detached.payload.isBackgrounded, "the detached run is the stoppable row");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX1 — a resumed session adopts the rehydrated row once, named, and merges by id", () => {
  const REHYDRATED = qwenBackgroundAgentId(SUBAGENT_TYPE, "c0ffee11");
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
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) => steps.emitText(TURN_TEXT).respondOk(),
    backgroundTasks: { entries },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-one-row-resume");
    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
    });
    yield* view.waitFor("the rehydrated task got a row", () => view.taskStarted().length > 0);

    // Resume is MODEL-driven (research §15.2); ids are immutable across
    // crash → paused → resumed (§15.3), so the running row is the SAME row.
    entries[0] = { ...entries[0]!, status: "running" };
    yield* view.waitFor("the resumed task reads running", () =>
      view.taskProgress().some((event) => event.payload.status === "running"),
    );
    entries[0] = { ...entries[0]!, status: "completed", endTime: 1_699_999_200_000 };
    yield* view.waitFor("the resumed task settled", () => view.taskCompleted().length > 0);

    const all = taskEvents(view);
    assert.deepStrictEqual(distinctTaskIds(all), [REHYDRATED], "the probe must adopt ONE row");
    assert.lengthOf(view.taskStarted(), 1, "the probe must not re-adopt on every tick");
    for (const event of all) {
      const title = (event.payload as { readonly title?: string }).title;
      assert.strictEqual(title, "Survey the repo", `${event.type} lost the row's name`);
    }
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX1 — the pseudo-turn's end_turn still reaches the native ACP log", () => {
  // Owner GO 2026-08-27: "restore `_qwencode/end_turn` to logNative in the
  // adapter's BackgroundTurnEnded case (mirror ContentDelta)."
  //
  // Registering the method by EXACT name (QwenAcpSessionRuntime, needed so the
  // signal arrives IN ORDER with the frames it terminates — mutation M5/M14)
  // took it off `handleUnknownExtNotification`, which was the path that logged
  // every ext-notification natively. The observability had to come back
  // explicitly; nothing pinned it until this spec.
  const outOfBand: { current: OutOfBand | undefined } = { current: undefined };
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) => steps.emitText(TURN_TEXT).respondOk(),
    onOutOfBandEmitter: (emit) => {
      outOfBand.current = emit;
    },
  };
  const native = collectNativeLog();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter({ nativeEventLogger: native.logger });
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-end-turn-log");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* outOfBand.current!.backgroundEndTurn("end_turn");
    yield* view.waitFor("the end_turn signal was logged natively", () =>
      native.written.some((entry) => entry.method === "_qwencode/end_turn"),
    );
    yield* view.stop;

    // The whole params struct, not a boolean: qwen sends exactly
    // `{sessionId, reason, source}` (Session.ts:6074-6087), and `reason` is the
    // only thing that distinguishes a normal end from a cancelled one.
    const logged = native.written.find((entry) => entry.method === "_qwencode/end_turn")!;
    assert.strictEqual((logged.payload as { readonly reason?: string }).reason, "end_turn");
    assert.strictEqual(
      (logged.payload as { readonly source?: string }).source,
      "background_notification",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("FIX1 — a launch payload with no task_id line opens NO background row (the guard)", () => {
  // The D-P3a-3 guard, re-aimed at the id (RULINGS 2026-08-27 F1 = OPTION A):
  // the id exists ONLY in the launch prose, so a frame whose prose does not
  // carry the `task_id: <id> (` line yields no id — and a row keyed by nothing
  // can never be updated by a poll, cancelled, or settled. It keeps its old
  // terminal treatment instead, and the failure is visible rather than a card
  // frozen at "Working" forever.
  //
  // Not a hypothetical: this is exactly what a fork, a future qwen that reworded
  // the line, or a truncated result would deliver.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitToolCallUpdate({
          toolCallId: TOOL_CALL_ID,
          toolName: "agent",
          status: "completed",
          text: "Background agent launched successfully.\nthe id line is gone.",
          rawOutput: qwenBackgroundLaunchResultDisplay({
            subagentName: SUBAGENT_TYPE,
            taskDescription: DESCRIPTION,
            taskPrompt: "do the work",
          }),
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-one-row-guard");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    const backgrounded = taskEvents(view).filter(
      (event) => (event.payload as { readonly isBackgrounded?: boolean }).isBackgrounded === true,
    );
    assert.lengthOf(
      backgrounded,
      0,
      "an unreadable launch must open no background row at all (D-P3a-3)",
    );
    // And nothing may invent the reconstructed id the wave used to build.
    assert.notInclude(
      distinctTaskIds(taskEvents(view)),
      `${SUBAGENT_TYPE}-${TOOL_CALL_ID}`,
      "the disproven `${subagentName}-${toolCallId}` reconstruction must be gone (F1)",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});
