// ru-code (agentic-flow wave, FIX ROUND 3): THE APPROVAL-MODE AXIS.
//
// The finding (adversary F-A3): on ru-code's DEFAULT runtime mode a foreground
// spawn's args-bearing `tool_call` frame DOES NOT EXIST. `AgentTool` overrides
// `getDefaultPermission()` to `'ask'` (qwen agent.ts:1566-1568) → the base
// class's generic `info` confirmation (tools.ts:126-140) →
// `needsConfirmation` is true in every non-YOLO mode (permissionFlow.ts:125-144)
// → `Session.ts:7651` sets `didRequestPermission` and `Session.ts:7861-7871`
// SKIPS `emitStart`. The spawn's name, type and prompt ride
// `session/request_permission` instead (`Session.ts:7677-7697`), and
// `resolveQwenMode` never asks qwen for yolo (QwenAdapter.ts:813-822).
//
// Every foreground spawn fixture in this wave modelled the AUTO_EDIT wire (the
// branch at `Session.ts:7621-7628`, where the `info` confirmation is
// auto-approved and `emitStart` still fires). So the mode the product ACTUALLY
// runs in was unmodelled, and on it nothing opened the agent window — which is
// what let a child's UNTAGGED plan (`PlanEmitter.emitPlan` takes no
// `subagentMeta`, qwen PlanEmitter.ts:27-39) be forwarded as
// `turn.plan.updated` and REPLACE the user's own task list.
//
// These specs are the adversary's PROBE C and PROBE C-control, promoted to
// real specs: the single variable between them is the frame the default-mode
// wire does not send.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
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
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { qwenSubAgentPermissionRequest, QWEN_INFO_PERMISSION_OPTIONS } from "./qwen021Frames.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-gated-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const CALL_ID = "call_gated01";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Review the diff";
const TURN_TEXT = "the parent's own reply";
/** The child's own todo list — untagged on the wire even at 0.21.1. */
const CHILD_PLAN = [
  { content: "read the diff", status: "in_progress" },
  { content: "write the review", status: "pending" },
];

const planUpdates = (view: BackgroundEventView) =>
  view.events.filter((event) => event.type === "turn.plan.updated");

const progressSummaries = (view: BackgroundEventView, taskId: string) =>
  view
    .taskProgress()
    .filter((event) => event.payload.taskId === taskId)
    .map((event) => (event.payload as { readonly summary?: string }).summary ?? "");

/** The child's settle frame — qwen's `AgentResultDisplay` (tools.ts:630-641). */
const agentSettle = {
  toolCallId: CALL_ID,
  toolName: "agent",
  status: "completed" as const,
  text: "done.",
  rawOutput: {
    type: "task_execution",
    subagentName: SUBAGENT_TYPE,
    taskDescription: DESCRIPTION,
    status: "completed",
    result: "done.",
  },
};

it.live("F-A3 — on the DEFAULT wire a gated spawn opens the window, so no child plan leaks", () => {
  // PROBE C, promoted. The wire: preparing frame → `session/request_permission`
  // carrying the args → (user allows) → the child's first act is a TodoWrite.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: CALL_ID,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        .emitPlan(CHILD_PLAN)
        .emitText("A is reviewing", { parentToolCallId: CALL_ID, subagentType: SUBAGENT_TYPE })
        .emitToolCallUpdate(agentSettle)
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const threadId = ThreadId.make("qwen-gated-plan");
    const view = yield* collectBackgroundEvents(adapter, { autoRespond: { threadId } });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    // THE DEFECT, named: the user's own task list must never be replaced by a
    // child's. A `turn.plan.updated` IS that replacement
    // (AcpCoreRuntimeEvents.ts:135-147 → the thread's single plan surface).
    assert.lengthOf(
      planUpdates(view),
      0,
      "the child's plan was forwarded as the PARENT's plan — the user's task list is gone",
    );
    // …and it is not lost either: it parks on the agent row.
    assert.isTrue(
      progressSummaries(view, CALL_ID).some((summary) => summary.includes("read the diff")),
      "the child's plan must land on the agent row",
    );

    // The row exists, is named from the args the PERMISSION frame carried, and
    // settles. Without the permission path the row is born only by orphan
    // adoption, which carries `taskId` + `role` and NO title
    // (QwenAcpSubAgents.ts:664-684) — so the card reads `call_…` for the run.
    const started = view.taskStarted().filter((event) => event.payload.taskId === CALL_ID);
    assert.lengthOf(started, 1, "a gated spawn must open exactly ONE row");
    assert.strictEqual(started[0]!.payload.title, DESCRIPTION);
    assert.notStrictEqual(started[0]!.payload.title, CALL_ID, "the card was named after a call id");
    assert.strictEqual(started[0]!.payload.role, SUBAGENT_TYPE);
    assert.isNotTrue(
      (started[0]!.payload as { readonly isBackgrounded?: boolean }).isBackgrounded,
      "an explicit run_in_background:false spawn is a FOREGROUND row",
    );
    assert.lengthOf(
      view.taskCompleted().filter((event) => event.payload.taskId === CALL_ID),
      1,
      "the gated row settles exactly once",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A3 control — the AUTO_EDIT wire (args frame, no gate) still parks the plan", () => {
  // PROBE C-control. The ONE variable is the args-bearing frame
  // (`Session.ts:7861-7871`, reached only when `didRequestPermission` is false).
  // This wire was already correct and must stay correct: the fix is additive.
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentPreparingStart(CALL_ID)
        .emitToolCall({
          toolCallId: CALL_ID,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: {
            description: DESCRIPTION,
            prompt: "do the work",
            subagent_type: SUBAGENT_TYPE,
            run_in_background: false,
          },
        })
        .emitPlan(CHILD_PLAN)
        .emitToolCallUpdate(agentSettle)
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-autoedit-plan");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;
    assert.lengthOf(planUpdates(view), 0, "the auto-edit wire must keep parking the child's plan");
    assert.isTrue(
      progressSummaries(view, CALL_ID).some((summary) => summary.includes("read the diff")),
      "the child's plan must land on the agent row",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A3 — a gated BACKGROUND spawn opens no row until qwen announces the real id", () => {
  // The selector axis crossed with the background rule. The permission frame
  // carries the FULL args, so qwen's own args rule
  // (`qwenSpawnArgsRunInBackground` ← toolClassification.ts:39-51) decides here
  // exactly as it does on the `tool_call` frame: a spawn that will detach gets
  // NO row from this frame — its row is opened by the launch update under
  // qwen's real registry id, the only id a poll or a cancel can address.
  const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "5e6f7a8b");
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: CALL_ID,
    }),
  ];
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: CALL_ID,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          runInBackground: true,
        })
        .emitBackgroundLaunch({
          toolCallId: CALL_ID,
          agentId: TASK_ID,
          subagentName: SUBAGENT_TYPE,
          taskDescription: DESCRIPTION,
          preparing: false,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
    backgroundTasks: { entries },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const threadId = ThreadId.make("qwen-gated-bg");
    const view = yield* collectBackgroundEvents(adapter, { autoRespond: { threadId } });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the detached run opened its row", () =>
      view.taskStarted().some((event) => event.payload.taskId === TASK_ID),
    );
    yield* view.stop;

    assert.lengthOf(
      view.taskStarted().filter((event) => event.payload.taskId === CALL_ID),
      0,
      "a gated spawn that will detach must open no row keyed by the wire call id",
    );
    assert.lengthOf(view.taskStarted(), 1, "one agent is one row on the gated wire too");
    assert.isTrue(view.taskStarted()[0]!.payload.isBackgrounded);
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A5 — a REJECTED spawn leaves no ghost card (the F-A1 sibling)", () => {
  // ru-code (agentic-flow wave, FIX ROUND 3 ADDENDUM, orchestrator-RATIFIED):
  // the sibling of F-A1, on the everyday path — the user presses Reject.
  //
  // qwen answers a declined (or otherwise early-errored) call through
  // `earlyErrorResponse` -> `this.toolCallEmitter.emitError(callId, toolName, error)`
  // (`Session.ts:7059`), whose frame is `status: 'failed'` with **no `rawOutput`**
  // — there is no `AgentResultDisplay`, because the agent never ran — and, unlike
  // the discard frame, **no `_meta.phase`** either. So T2's guard cannot see it:
  // it fell to the terminal arm, where every field that arm reads is undefined,
  // and `task.completed` went out titleless. `foldSubagentActivities` calls
  // `getOrCreate` for `task.completed` too (subagentRuntime.ts:554-692) and names
  // the card `asString(title) ?? asString(detail) ?? id` (`:362`) — a permanent
  // red card named after the wire call id, for an agent the user explicitly
  // REFUSED to run. Probe output on the unfixed tree:
  //   task.completed {taskId:"call_reject01", status:"failed"}   (no title)
  //
  // The rejection itself is not swallowed: the call still reaches the timeline
  // as an ordinary tool item — exactly what every OTHER rejected tool does,
  // since a non-agent `emitError` frame classifies `PlainToolCall`.
  const REJECTED = "call_reject01";
  const REJECT_MESSAGE = 'Tool "agent" was canceled by the user.';
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: REJECTED,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        // qwen's own wording for a user rejection (`Session.ts:7702`).
        .emitToolCallError({
          toolCallId: REJECTED,
          toolName: "agent",
          errorMessage: REJECT_MESSAGE,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  const native = collectNativeLog();
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter({ nativeEventLogger: native.logger });
    const threadId = ThreadId.make("qwen-gated-rejected");
    const view = yield* collectBackgroundEvents(adapter, {
      autoRespond: { threadId, decision: "decline" },
    });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    // FIXTURE FIDELITY — the refusal frame's own bytes, off the native ACP log.
    // Without this every assertion below is an absence that holds even better
    // when the frame was never sent (the M28 lesson), and the error text in
    // particular used to be DROPPED by the builder (see `qwenEmitToolCallError`).
    const refusal = native.written.find((entry) => {
      const update = (entry.payload as { readonly update?: Record<string, unknown> })?.update;
      return (
        update?.["sessionUpdate"] === "tool_call_update" && update?.["toolCallId"] === REJECTED
      );
    });
    assert.isDefined(refusal, "the fake must emit qwen's emitError frame");
    const update = (refusal!.payload as { readonly update: Record<string, unknown> }).update;
    assert.strictEqual(update["status"], "failed", "transcript-replay.ts:279 (success:false)");
    assert.isUndefined(
      update["rawOutput"],
      "emitError sends NO AgentResultDisplay — that is what makes this a run that never happened",
    );
    assert.isUndefined(
      (update["_meta"] as Record<string, unknown>)["phase"],
      "and no preparing phase either — which is why T2's discard guard cannot see it",
    );
    assert.deepStrictEqual(
      update["content"],
      [{ type: "content", content: { type: "text", text: REJECT_MESSAGE } }],
      "the error message is the frame's only content (transcript-replay.ts:1112-1119)",
    );

    // THE FULL ROW SET — a refused spawn is not an agent, in any event kind.
    assert.deepStrictEqual(
      [...view.taskStarted(), ...view.taskCompleted(), ...view.taskProgress()].map(
        (event) => `${event.type}:${String(event.payload.taskId)}`,
      ),
      [],
      "a REFUSED spawn produced an agent row — a red card for a run the user declined",
    );
    // The refusal still reached the user's timeline as an ordinary tool item —
    // and NOT homed to an agent, because there is no agent row to home it to.
    const items = view.itemEvents();
    assert.isAtLeast(
      items.length,
      1,
      "the rejected call vanished entirely — it must still show as a failed tool",
    );
    assert.lengthOf(
      items.filter(
        (event) => (event.payload as { readonly agentId?: unknown }).agentId !== undefined,
      ),
      0,
      "the refused call was attributed to an agent row that does not exist",
    );
    // And the parent's own turn is untouched.
    assert.strictEqual(view.chatText(), TURN_TEXT);
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A5 — a row that WAS opened still settles on a rawOutput-less terminal", () => {
  // THE SECOND HALF OF THE CONDITION, and it is not hypothetical. On the
  // AUTO_EDIT wire `emitStart` fires at `Session.ts:7870` — the row opens — and
  // the PreToolUse hook runs immediately AFTER it (`:7878-7889`); a hook that
  // blocks returns `earlyErrorResponse(new Error(blockReason), toolName)`
  // (`:7890-7897`), i.e. the same `emitError` frame with no `AgentResultDisplay`.
  //
  // So "no result display" alone must NOT mean "settle nothing": that card
  // exists, and leaving it unsettled is the immortal "Working" row this wave
  // exists to kill. Only "no result display AND no row we opened" is silence.
  const BLOCKED = "call_blocked9";
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentPreparingStart(BLOCKED)
        .emitToolCall({
          toolCallId: BLOCKED,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: {
            description: DESCRIPTION,
            prompt: "do the work",
            subagent_type: SUBAGENT_TYPE,
            run_in_background: false,
          },
        })
        // qwen's own notice, then its own error frame (`Session.ts:7893-7897`).
        .emitText(`✗ **PreToolUse blocked**: agent - denied by hook`)
        .emitToolCallError({
          toolCallId: BLOCKED,
          toolName: "agent",
          errorMessage: "denied by hook",
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make("qwen-hook-blocked");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    assert.lengthOf(view.taskStarted(), 1, "the args frame opened the row");
    assert.lengthOf(
      view.taskCompleted(),
      1,
      "the opened row was left running forever — a hook-blocked agent must settle",
    );
    assert.strictEqual(view.taskCompleted()[0]!.payload.status, "failed");
    assert.strictEqual(view.taskCompleted()[0]!.payload.taskId, BLOCKED);
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A5 — a refusal leaves no tombstone: the SAME call id can still run", () => {
  // RETRY SEMANTICS, made mechanical rather than argued.
  //
  // A rejected call is COMPLETE in qwen's own history — `earlyErrorResponse`
  // records a tool result for it (`Session.ts:7063`) — so the provider-assigned
  // `fc.id` (`Session.ts:6983`) is not re-executed in practice. But the guard
  // must not DEPEND on that: it remembers nothing (no `rememberSettledAgent`),
  // precisely so a reused id is treated as the fresh call it is. Tombstoning
  // would make every frame of the later run a dropped straggler
  // (`isQwenSettledAgentFrame`), i.e. an agent that runs invisibly.
  const REUSED = "call_reject01";
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: REUSED,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        .emitToolCallError({
          toolCallId: REUSED,
          toolName: "agent",
          errorMessage: 'Tool "agent" was canceled by the user.',
        })
        // …the model tries again and the user allows it this time. Modelled as
        // the AUTO_EDIT wire so the second attempt needs no second decision from
        // the harness (one script, one auto-response).
        .emitToolCall({
          toolCallId: REUSED,
          toolName: "agent",
          title: `Agent: ${DESCRIPTION}`,
          rawInput: {
            description: DESCRIPTION,
            prompt: "do the work",
            subagent_type: SUBAGENT_TYPE,
            run_in_background: false,
          },
        })
        .emitToolCallUpdate(agentSettle)
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const threadId = ThreadId.make("qwen-gated-reject-retry");
    const view = yield* collectBackgroundEvents(adapter, {
      autoRespond: { threadId, decision: "decline" },
    });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the retried spawn settled", () => view.taskCompleted().length > 0);
    yield* view.stop;

    assert.lengthOf(view.taskStarted(), 1, "the retried run must open exactly one row");
    assert.strictEqual(view.taskStarted()[0]!.payload.title, DESCRIPTION);
    assert.lengthOf(view.taskCompleted(), 1, "and settle exactly once");
    assert.strictEqual(view.taskCompleted()[0]!.payload.status, "completed");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A3 — a second gated spawn does not mark the FIRST agent as waiting", () => {
  // qwen batches consecutive `agent` calls concurrently (Session.ts:6742-6796),
  // so a second spawn's permission request arrives while the first agent's
  // window is open. That request is the PARENT asking to launch another agent —
  // not the running child pausing for input — and the "waiting" marker resolves
  // through the SERIAL window, which by then belongs to agent A. Marking A
  // waiting would tell the user that A is holding for an answer it never asked
  // for.
  const CALL_A = "call_gatedA1";
  const CALL_B = "call_gatedB2";
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: CALL_A,
          description: "Review the diff",
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        .emitAgentSpawnGated({
          callId: CALL_B,
          description: "Audit the config",
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const threadId = ThreadId.make("qwen-gated-concurrent");
    const view = yield* collectBackgroundEvents(adapter, { autoRespond: { threadId } });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "spawn two agents" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    assert.lengthOf(view.taskStarted(), 2, "both gated spawns must get a row");
    assert.lengthOf(
      view
        .taskProgress()
        .filter(
          (event) =>
            event.payload.taskId === CALL_A &&
            (event.payload as { readonly status?: string }).status === "waiting",
        ),
      0,
      "agent A was shown as waiting for an approval the PARENT was asked for",
    );
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});

it.live("F-A3 — a NESTED spawn's permission request opens no ROOT row", () => {
  // THE BOUND ON THE FIX, and the reason it reads the title.
  //
  // Two producers build an `agent` permission request and NEITHER carries an
  // attribution tag: `Session.ts:7677-7697` (top level) and
  // `SubAgentTracker.ts:207-228` (a CHILD spawning its own sub-agent — nested
  // sub-agents carry the AgentTool, agent.ts:2158). The byte that separates
  // them is the title: the top-level one is `invocation.getDescription()`
  // verbatim (`:7683` → agent.ts:1554-1556), the nested one is
  // `resolveToolMetadata`'s `displayName + ': ' + description`
  // (tool-call-emitter.ts:334/:341) = `Agent: <description>`.
  //
  // Getting this wrong is not cosmetic: a nested spawn's own frames carry
  // `parentToolCallId` and classify `AgentInnerTool`, so a root row opened for
  // one would never be settled by anything — a permanent "Working" card.
  const NESTED_CALL = "call_nested7";
  const PARENT_CALL = "call_parent1";
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitAgentSpawnGated({
          callId: PARENT_CALL,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          runInBackground: false,
        })
        .requestPermission(
          qwenSubAgentPermissionRequest({
            sessionId: FAKE_SESSION_ID,
            callId: NESTED_CALL,
            toolName: "agent",
            // `Agent` is `ToolDisplayNames.AGENT` (tool-names.ts:89).
            title: `Agent: nested work`,
            // `run_in_background: false` on purpose: without it qwen's own args
            // rule resolves this spawn to BACKGROUND (agent.ts:2526-2536), which
            // opens no row either — and then the title would not be what keeps
            // the root row from existing. The mutation battery caught exactly
            // that (M31 came back GREEN on the first form of this spec).
            args: {
              description: "nested work",
              prompt: "p",
              subagent_type: SUBAGENT_TYPE,
              run_in_background: false,
            },
            options: [...QWEN_INFO_PERMISSION_OPTIONS],
          }),
        )
        .emitToolCallUpdate({
          toolCallId: PARENT_CALL,
          toolName: "agent",
          status: "completed",
          text: "done.",
          rawOutput: {
            type: "task_execution",
            subagentName: SUBAGENT_TYPE,
            taskDescription: DESCRIPTION,
            status: "completed",
            result: "done.",
          },
        })
        .emitText(TURN_TEXT)
        .respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const threadId = ThreadId.make("qwen-gated-nested");
    const view = yield* collectBackgroundEvents(adapter, { autoRespond: { threadId } });
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "review the diff" });
    yield* view.waitFor("the parent's own turn reply landed", () =>
      view.chatText().includes(TURN_TEXT),
    );
    yield* view.stop;

    const ids = new Set(
      (
        [...view.taskStarted(), ...view.taskCompleted()] as ReadonlyArray<
          Extract<ProviderRuntimeEvent, { type: "task.started" | "task.completed" }>
        >
      ).map((event) => String(event.payload.taskId)),
    );
    assert.isFalse(
      ids.has(NESTED_CALL),
      "a nested spawn's permission request opened a root row nothing can ever settle",
    );
    assert.isTrue(ids.has(PARENT_CALL), "the top-level gated spawn still gets its row");
  }).pipe(Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)));
});
