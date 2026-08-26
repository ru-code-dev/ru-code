// ru-code (agentic-flow wave, P2): the born-red matrix for COMPLETION→CHAT,
// DISPATCH BANKING and the STOP COMPOSITE — P3c, P3d and P3e of the wave plan.
//
// Every background byte comes from the 1:1 transcription in
// `qwen021BackgroundAgents.ts`.
//
// What these specs pin:
//   1. qwen's self-initiated pseudo-turn (research §3.3) speaks with NO
//      `session/prompt` of ours in flight. Its content must reach the chat as
//      its OWN assistant message, closed promptly — not left latent in
//      ingestion's buffer until an unrelated later turn flushes it
//      (bg-probe/run7.log §1.3).
//   2. `_qwencode/end_turn` (Session.ts:6074-6087) is the only reliable "the
//      pseudo-turn is over" signal, and it must close that message.
//   3. A user send can never destroy a pending completion: the open background
//      message is banked (closed) BEFORE any prompt is dispatched, because
//      qwen's own `prompt()` wholesale-discards its notification queue
//      (research §10.4) and anything already delivered to us must survive.
//   4. The per-row stop calls `qwen/control/session/task/cancel` with the
//      REQUIRED `taskKind: "agent"` (acpAgent.ts:9388-9397 rejects anything
//      else), and the row settles.
//   5. A CLI crash flips a live background row to stopped — the card stays.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../config.ts";
import {
  collectBackgroundEvents,
  makeBackgroundAdapter,
  runningTaskEntry,
  TEST_BACKGROUND_POLL_INTERVAL_MS,
} from "./backgroundHarness.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import {
  qwenBackgroundAgentId,
  qwenBackgroundDisplayLine,
  qwenBuildBackgroundEntryLabel,
  type QwenAgentTaskEntry,
} from "./qwen021BackgroundAgents.ts";
import { qwenBackgroundCompletionLine } from "../../../qwen/background/backgroundTaskContract.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-done-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// ru-code (agentic-flow wave, FIX ROUND 1): the real wire shapes. The agent id's suffix is a
// random 8-hex slice (agent.ts:2839), NOT the wire tool call id — so these two
// constants share nothing, exactly as real qwen 0.21.1 puts them on the wire.
const TOOL_CALL_ID = "call_bg2d4e5f";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "3c7d90fe");
const TURN_TEXT = "the parent's own reply";
const MODEL_NARRATION = "The audit found two issues.";

/** qwen's own line (background-tasks.ts:1556-1564), built by the transcription. */
const DISPLAY_LINE = qwenBackgroundDisplayLine({
  description: DESCRIPTION,
  subagentType: SUBAGENT_TYPE,
  status: "completed",
});

type OutOfBand = Parameters<NonNullable<FakeAcpScript["onOutOfBandEmitter"]>>[0];

const makeState = (backgroundTasks?: FakeBackgroundTasksOptions) => {
  const outOfBand: { current: OutOfBand | undefined } = { current: undefined };
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
    ...(backgroundTasks ? { backgroundTasks } : {}),
  };
  return { script, outOfBand };
};

it.live(
  "P3c — the pseudo-turn's completion becomes its own assistant message, closed by end_turn",
  () => {
    const state = makeState();
    return Effect.gen(function* () {
      const adapter = yield* makeBackgroundAdapter();
      const view = yield* collectBackgroundEvents(adapter);
      const threadId = ThreadId.make("qwen-bg-completion");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "launch an agent" });
      yield* view.waitFor("the parent's own turn reply landed", () =>
        view.chatText().includes(TURN_TEXT),
      );
      const itemsBefore = view.itemEvents().length;
      const emit = state.outOfBand.current;
      assert.isDefined(emit, "the fake never handed over its out-of-band emitter");

      // The pseudo-turn: qwen's canned display line, then the model's own words,
      // then the nonstandard end-of-turn extNotification.
      yield* emit!.backgroundNotificationDisplay({
        taskId: TASK_ID,
        description: DESCRIPTION,
        subagentType: SUBAGENT_TYPE,
        status: "completed",
        toolUseId: TOOL_CALL_ID,
      });
      yield* emit!.backgroundNotificationResponse(
        { taskId: TASK_ID, status: "completed", toolUseId: TOOL_CALL_ID },
        MODEL_NARRATION,
      );
      yield* emit!.backgroundEndTurn("end_turn");

      yield* view.waitFor("the background completion reached the chat", () =>
        view.chatText().includes(MODEL_NARRATION),
      );
      assert.include(view.chatText(), DISPLAY_LINE, "qwen's own completion line must be shown");

      // It belongs to NO turn of ours: an orphan attributed to a real turn is the
      // splice defect (see backgroundOrphanSplice.e2e.test.ts).
      const backgroundDelta = view
        .contentDeltas()
        .find((event) => event.payload.delta.includes(MODEL_NARRATION));
      assert.isDefined(backgroundDelta);
      assert.isUndefined(
        backgroundDelta!.turnId,
        "background content must carry no turn of ours (research §3.3: there is none)",
      );

      // It is a MESSAGE OF ITS OWN, and it is CLOSED — an unclosed item leaves
      // the text latent in ingestion's buffer forever.
      //
      // Identified by the item the background DELTA carried, never by "some
      // item.completed arrived after this point": the parent turn's own segment
      // closes around here too, and an assertion that could not tell them apart
      // stayed green with the end_turn handler deleted (mutation M5).
      const backgroundItemId = backgroundDelta!.itemId;
      assert.isDefined(backgroundItemId, "the background completion needs its own item");
      assert.isTrue(
        view
          .itemEvents()
          .slice(itemsBefore)
          .some((event) => event.type === "item.started" && event.itemId === backgroundItemId),
        "the background completion needs its own assistant item",
      );
      yield* view.waitFor("the background message was closed by end_turn", () =>
        view
          .itemEvents()
          .some((event) => event.type === "item.completed" && event.itemId === backgroundItemId),
      );

      // Both frames of ONE notification share that item — qwen never batches two
      // tasks into one pseudo-turn (research §16.6).
      const displayDelta = view
        .contentDeltas()
        .find((event) => event.payload.delta.includes(DISPLAY_LINE));
      assert.strictEqual(displayDelta?.itemId, backgroundItemId);
      yield* view.stop;
    }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
  },
);

it.live("P3c — a completion on an IDLE session leaves no empty bubble in the parent chat", () => {
  // The other half of "a background frame never touches the assistant-segment
  // machinery". With a segment OPEN the frame must not join it (the splice
  // repro); with NO segment open it must not MINT one either, or the parent chat
  // keeps an empty assistant bubble that the adapter then talks past — the
  // background content goes to its own item, so the minted segment would never
  // receive a byte. Nothing pinned this until mutation M3 showed the guard could
  // be deleted with every spec still green.
  const state = makeState();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-idle-bubble");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    // The turn has settled, so the parent's segment is closed: any item started
    // from here on was started BY this completion.
    const mark = view.itemEvents().length;

    const emit = state.outOfBand.current!;
    yield* emit.backgroundNotificationDisplay({
      taskId: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      status: "completed",
      toolUseId: TOOL_CALL_ID,
    });
    yield* emit.backgroundEndTurn("end_turn");
    yield* view.waitFor("the completion reached the chat", () =>
      view.chatText().includes(DISPLAY_LINE),
    );

    const backgroundItemId = view
      .contentDeltas()
      .find((event) => event.payload.delta.includes(DISPLAY_LINE))?.itemId;
    assert.isDefined(backgroundItemId);
    const startedAfter = view
      .itemEvents()
      .slice(mark)
      .filter((event) => event.type === "item.started");
    assert.deepStrictEqual(
      startedAfter.map((event) => event.itemId),
      [backgroundItemId],
      "a background completion must start exactly ONE item — its own",
    );
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it.live("P3c — a terminal the push never announced is still said in chat, exactly once", () => {
  // PULL IS THE GUARANTEE (wave plan). qwen's notification queue caps at 20 and
  // evicts silently (research §16.6), and any `session/prompt` landing
  // mid-delivery discards it outright (§10.4) — so a completion can be lost on
  // the push channel entirely. The poll saw the terminal; the chat has to say it
  // anyway, in qwen's OWN words, and never twice.
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const state = makeState({ entries });
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-pull");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the background row opened", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );

    // The task finishes. NO pseudo-turn frame is ever pushed.
    entries[0] = {
      ...entries[0]!,
      status: "completed",
      endTime: 1_699_999_200_000,
      notified: true,
    };
    yield* view.waitFor("the row settled from the poll", () =>
      view.taskCompleted().some((event) => event.payload.taskId === TASK_ID),
    );
    yield* view.waitFor("the completion was said in chat by the PULL", () =>
      view.chatText().includes(DISPLAY_LINE),
    );

    // qwen's own sentence, not one we invented.
    const said = view.contentDeltas().filter((event) => event.payload.delta.includes(DISPLAY_LINE));
    assert.lengthOf(said, 1, "a completion must be announced exactly once");
    assert.strictEqual(said[0]!.payload.delta, DISPLAY_LINE);
    assert.isUndefined(said[0]!.turnId, "the fallback belongs to no turn of ours either");

    // And it is CLOSED — no `end_turn` is coming for a delivery qwen never made,
    // so nothing else would ever flush it out of ingestion's buffer.
    yield* view.waitFor("the fallback message was closed", () =>
      view
        .itemEvents()
        .some((event) => event.type === "item.completed" && event.itemId === said[0]!.itemId),
    );
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it.live("P3c — push and pull both see the same terminal, and it is said exactly once", () => {
  // The two routes are deliberately independent — the push is qwen's own
  // pseudo-turn, the pull is our poll — so they WILL both fire for the same
  // task. `backgroundChatDelivered` is what keeps that from becoming two
  // messages saying the same thing.
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const state = makeState({ entries });
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-dedupe");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the background row opened", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );

    // The PUSH lands first — qwen's normal, healthy path.
    const emit = state.outOfBand.current!;
    yield* emit.backgroundNotificationDisplay({
      taskId: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      status: "completed",
      toolUseId: TOOL_CALL_ID,
    });
    yield* emit.backgroundEndTurn("end_turn");
    yield* view.waitFor("the push said it", () => view.chatText().includes(DISPLAY_LINE));

    // …and only THEN does the registry flip, so the poll sees the terminal too.
    entries[0] = {
      ...entries[0]!,
      status: "completed",
      endTime: 1_699_999_200_000,
      notified: true,
    };
    yield* view.waitFor("the row settled from the poll", () =>
      view.taskCompleted().some((event) => event.payload.taskId === TASK_ID),
    );
    // Long enough for the fallback's grace tick to have come and gone.
    yield* Effect.sleep(`${TEST_BACKGROUND_POLL_INTERVAL_MS * 6} millis`);

    assert.lengthOf(
      view.contentDeltas().filter((event) => event.payload.delta.includes(DISPLAY_LINE)),
      1,
      "a completion seen by BOTH routes must still be said exactly once",
    );
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it("FIX3 — the pull's line is BYTE-EQUAL to qwen's own, on every terminal status", () => {
  // ru-code (agentic-flow wave, FIX ROUND 3, F-A4): the fallback used to append
  // `"\nError: <error>"` — a sentence qwen never says. Its user-facing line is
  // `displayLine` (background-tasks.ts:1556-1564) and has no error suffix on any
  // status; `Error: ` appears only inside the MODEL-FACING `<task-notification>`
  // XML (`:1580-1581`). Push and pull therefore rendered the SAME event
  // differently, and the extra line was a server-side English literal lifted
  // from a surface this wave guarantees the user never sees.
  //
  // Asserted against the TRANSCRIPTION, not against a string typed here: the
  // fixture builder is the one thing pinned to qwen's own emitter.
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const entry = { description: DESCRIPTION, subagentType: SUBAGENT_TYPE, status };
    assert.strictEqual(
      qwenBackgroundCompletionLine({
        label: qwenBuildBackgroundEntryLabel(entry),
        status,
      }),
      qwenBackgroundDisplayLine(entry),
      `the pull invented words qwen never says for a ${status} agent`,
    );
  }
});

it.live("FIX3 — a LATE push after the pull said it does not announce the completion twice", () => {
  // ru-code (agentic-flow wave, FIX ROUND 3, F-A2): THE DEDUPE WAS
  // ONE-DIRECTIONAL. `offerBackgroundChat` WROTE `backgroundChatDelivered` and
  // never READ it, so the doc claim above it — "a completion can never be
  // announced twice whichever route wins" — held only for push-then-pull.
  //
  // The window is qwen's, not ours: `#drainNotificationQueue` returns early on
  // `pendingPrompt || cronProcessing || cronAbortController ||
  // #deferAutomaticQueueDrainUntilTurnsSettle()` (Session.ts:5688-5697), and
  // `#nextNotificationQueueIndex` (`:5767-5775`) yields -1 while the todo stop
  // guard blocks automatic turns. Nothing retries on a timer — the only re-drain
  // is the `finally` of a drain that actually ran (`:5753-5760`) — while our
  // fallback needs two idle poll ticks. So qwen can hold the push arbitrarily
  // long and still deliver it.
  //
  // The RESPONSE frame must still arrive: it carries the model's own words,
  // which the fallback can never reconstruct from a snapshot.
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const state = makeState({ entries });
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-dedupe-late-push");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the background row opened", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );

    // The registry flips FIRST and the push is still gated inside qwen, so the
    // PULL is what tells the user.
    entries[0] = {
      ...entries[0]!,
      status: "completed",
      endTime: 1_699_999_200_000,
      notified: true,
    };
    yield* view.waitFor("the completion was said by the PULL", () =>
      view.chatText().includes(DISPLAY_LINE),
    );

    // …and only THEN does qwen's drain unblock and deliver the same completion.
    const emit = state.outOfBand.current!;
    yield* emit.backgroundNotificationDisplay({
      taskId: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      status: "completed",
      toolUseId: TOOL_CALL_ID,
    });
    yield* emit.backgroundNotificationResponse(
      { taskId: TASK_ID, status: "completed", toolUseId: TOOL_CALL_ID },
      MODEL_NARRATION,
    );
    yield* emit.backgroundEndTurn("end_turn");
    yield* view.waitFor("the model's own narration reached the chat", () =>
      view.chatText().includes(MODEL_NARRATION),
    );
    // Long enough for anything still in flight on either route to have landed.
    yield* Effect.sleep(`${TEST_BACKGROUND_POLL_INTERVAL_MS * 6} millis`);
    yield* view.stop;

    assert.lengthOf(
      view.contentDeltas().filter((event) => event.payload.delta.includes(DISPLAY_LINE)),
      1,
      "the user was told the same completion twice — once by the pull, once by the push",
    );
    assert.lengthOf(
      view.contentDeltas().filter((event) => event.payload.delta.includes(MODEL_NARRATION)),
      1,
      "the model's own words must still be delivered — the fallback cannot reconstruct them",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it.live("P3d — a pending completion is banked before the next prompt is dispatched", () => {
  const state = makeState();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-banking");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );

    const emit = state.outOfBand.current!;
    // A completion arrives and its `end_turn` NEVER does — qwen drops that
    // notification whenever the delivery is superseded (research §11.5).
    yield* emit.backgroundNotificationDisplay({
      taskId: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      status: "completed",
      toolUseId: TOOL_CALL_ID,
    });
    yield* view.waitFor("the completion reached the chat stream", () =>
      view.chatText().includes(DISPLAY_LINE),
    );
    // The item the completion is streaming into — identified by its OWN delta,
    // not by "whatever item was last opened", so the assertion cannot be
    // satisfied by the parent segment happening to close.
    const backgroundItemId = view
      .contentDeltas()
      .find((event) => event.payload.delta.includes(DISPLAY_LINE))?.itemId;
    assert.isDefined(backgroundItemId, "the completion never got an item of its own");
    assert.isFalse(
      view
        .itemEvents()
        .some((event) => event.type === "item.completed" && event.itemId === backgroundItemId),
      "precondition: the background item is still open before the send",
    );

    // The user sends. The banked completion must be CLOSED FIRST — the claim is
    // ORDERING, not eventual closure: the turn finalizer banks too, so "it ended
    // up closed" is satisfied either way and stayed green with the dispatch-time
    // bank deleted (mutation M4). What only the dispatch-time bank can give is a
    // close that precedes the new turn's own first byte.
    const mark = view.events.length;
    yield* adapter.sendTurn({ threadId, input: "and now this" });
    const closeIndex = view.events.findIndex(
      (event, index) =>
        index >= mark && event.type === "item.completed" && event.itemId === backgroundItemId,
    );
    assert.isAtLeast(
      closeIndex,
      0,
      "a pending background completion must be banked before a prompt is dispatched",
    );
    const nextTurnDeltaIndex = view.events.findIndex(
      (event, index) =>
        index >= mark && event.type === "content.delta" && event.payload.delta.includes(TURN_TEXT),
    );
    assert.isAtLeast(nextTurnDeltaIndex, 0, "the second turn never streamed");
    assert.isBelow(
      closeIndex,
      nextTurnDeltaIndex,
      "the completion must be banked BEFORE the new turn produces content",
    );

    // And the new turn's own reply is a DIFFERENT message — banking that left
    // the two in one bubble would be the splice defect with extra steps.
    const turnDeltaItemIds = new Set(
      view
        .contentDeltas()
        .filter((event) => event.payload.delta.includes(TURN_TEXT))
        .map((event) => event.itemId),
    );
    assert.isFalse(
      turnDeltaItemIds.has(backgroundItemId),
      "the background completion shares an item with a real turn's reply",
    );
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it.live("P3e — the per-row stop cancels the task with taskKind agent and settles the row", () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const cancels: Array<{ taskId: string; taskKind: string }> = [];
  const backgroundTasks: FakeBackgroundTasksOptions = {
    entries,
    onCancel: (params) => {
      cancels.push(params);
    },
  };
  const state = makeState(backgroundTasks);
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-stop");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the background row opened", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );

    assert.isDefined(
      adapter.stopBackgroundTask,
      "the qwen adapter must expose a per-task stop for background agents",
    );
    yield* adapter.stopBackgroundTask!(threadId, TASK_ID);

    // acpAgent.ts:9388-9397 — `taskKind` is required and validated; omitting it
    // (or sending anything else) is an invalidParams rejection, not a cancel.
    assert.deepStrictEqual(cancels, [{ taskId: TASK_ID, taskKind: "agent" }]);

    // The cancel mutates the live registry entry, so the very next poll reports
    // it (research §14.1, object identity) and the row settles as stopped.
    yield* view.waitFor("the cancelled row settled", () =>
      view.taskCompleted().some((event) => event.payload.taskId === TASK_ID),
    );
    assert.strictEqual(
      view.taskCompleted().find((event) => event.payload.taskId === TASK_ID)!.payload.status,
      "stopped",
      "a cancel is a STOP, not a failure",
    );
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});

it.live("P3e — a CLI crash flips a live background row to stopped, and the card stays", () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const state = makeState({ entries });
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-bg-crash");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the background row opened", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );

    // The CLI dies. Background tasks die with it (their registry is in-memory,
    // research §14.3), so a row left "Working" would lie forever.
    yield* adapter.stopSession(threadId);

    yield* view.waitFor("the crashed background row settled", () =>
      view.taskCompleted().some((event) => event.payload.taskId === TASK_ID),
    );
    const settled = view.taskCompleted().find((event) => event.payload.taskId === TASK_ID)!;
    assert.strictEqual(settled.payload.status, "stopped");
    // The CARD STAYS (RULINGS 2026-08-27): a terminal row, never a removal.
    assert.strictEqual(settled.payload.taskType, "subagent");
    yield* view.stop;
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(state.script), testServices)));
});
