// ru-code (agents wave, phase 2): THE RED v2 MATRIX — born-red by design.
//
// Every spec below asserts the qwen 0.21.1 contract our adapter does NOT yet
// honour. They are expected to FAIL on current main and to go green in phase 3;
// the `.broken.test.ts` suffix is this repo's existing marker for a spec that
// pins a known gap rather than a regression (see answersWire.broken.test.ts,
// which carried the same suffix until its gap was closed).
//
// The whole file runs against dialect "v2" — the 1:1 transcription of qwen's
// 0.21.1 emitters in qwen021Frames.ts. That matters: a matrix written against
// hand-made fixtures would prove only that we can satisfy our own guesses. Here
// every byte on the wire traces to a qwen src line (mapping table:
// WORKFLOW/wave-agents-mapping-table.md).
//
// The v1 suites next door are untouched and MUST stay green — they are the
// wave's regression anchor.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-v2-matrix-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const AGENT_A = "call-agent-A";
const AGENT_B = "call-agent-B";
const INNER_A = "call-inner-A";
const INNER_B = "call-inner-B";
const ROLE_A = "code-reviewer";
const ROLE_B = "planner";
const SENTINEL = "V2_MATRIX_SENTINEL";

const META_A = { parentToolCallId: AGENT_A, subagentType: ROLE_A };
const META_B = { parentToolCallId: AGENT_B, subagentType: ROLE_B };

type TaskProgress = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
type TaskCompleted = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type ContentDelta = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;

const agentRoot = (callId: string, description: string, role: string) => ({
  toolCallId: callId,
  toolName: "agent",
  title: `Agent: ${description}`,
  rawInput: { description, prompt: "p", subagent_type: role, run_in_background: false },
});

const agentSettle = (callId: string, role: string, description: string, result: string) => ({
  toolCallId: callId,
  toolName: "agent",
  status: "completed" as const,
  text: result,
  rawOutput: {
    type: "task_execution",
    subagentName: role,
    taskDescription: description,
    status: "completed",
    result,
    executionSummary: { totalDurationMs: 1000, totalToolCalls: 1, totalTokens: 100 },
  },
});

/** Collects the adapter's event stream until `done` fires (or the timeout). */
const runV2 = (
  script: FakeAcpScript,
  threadId: string,
  isDone: (event: ProviderRuntimeEvent) => boolean,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(Effect.andThen(isDone(event) ? Deferred.succeed(done, undefined) : Effect.void)),
    ).pipe(Effect.forkChild);

    const id = ThreadId.make(threadId);
    yield* adapter.startSession({
      threadId: id,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* Effect.exit(adapter.sendTurn({ threadId: id, input: "go" }));
    // ru-code (phase 4, f-15): 30s, not 10s. Seat B measured the 10s bound
    // failing on a COLD run whose transform+import alone took 26.5s, then
    // passing on three consecutive warm runs. A gate that reads green only on a
    // warm machine is not a gate.
    yield* Deferred.await(done).pipe(Effect.timeout("30 seconds"));
    yield* Fiber.interrupt(fiber);
    return events;
  });

const progressFor = (events: ReadonlyArray<ProviderRuntimeEvent>, taskId: string) =>
  events
    .filter((e): e is TaskProgress => e.type === "task.progress" && e.payload.taskId === taskId)
    .map((e) => e.payload.summary ?? "")
    .filter((line) => line.length > 0);

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 7. TAG-KEYED CONCURRENT DEMUX, and the running-agents count.
//
// v0.21.1 runs consecutive Agent-tool calls CONCURRENTLY through a bounded pool
// (contract doc §11.1/§11.2; qwen Session.ts:6621-6627 batches consecutive
// `agent` calls with `concurrent:true`, `runBounded` at :6742-6796 starts the
// next before the previous resolves). Two roots are therefore open at once and
// their child frames INTERLEAVE.
//
// Our adapter keeps ONE window (`ctx.subAgentWindow`, QwenAdapter.ts:374) and
// overwrites it on the second root (:2268), so today agent A's later narration
// is attributed to agent B. The tag makes this decidable: every interleaved
// frame carries its own `_meta.parentToolCallId`.
//
// The running-agents COUNT rides here rather than in its own spec: with a
// single window the two rows still both open, so a count-only assertion passes
// today and would be decorative. What is genuinely red is both agents being
// live AND each accumulating its own line.
const concurrentScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall(agentRoot(AGENT_B, "Plan the migration", ROLE_B))
      // Interleaved, each tagged to its own parent — the shape a bounded pool
      // of two produces.
      .emitText("A is reading the diff carefully and at some length", META_A)
      .emitText("B is drafting the migration plan in its own words", META_B)
      .emitToolCall({
        toolCallId: INNER_A,
        toolName: "read_file",
        title: "read_file: /a.ts",
        status: "pending",
        kind: "read",
        rawInput: { absolute_path: "/a.ts" },
        subagentMeta: META_A,
      })
      .emitToolCall({
        toolCallId: INNER_B,
        toolName: "write_file",
        title: "write_file: /plan.md",
        status: "pending",
        kind: "edit",
        rawInput: { absolute_path: "/plan.md" },
        subagentMeta: META_B,
      })
      .emitText("A found three suspicious null checks worth reporting", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff", "A done."))
      .emitToolCallUpdate(agentSettle(AGENT_B, ROLE_B, "Plan the migration", "B done."))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("v2 · two concurrent agents demux by tag, never by whichever window is open", () =>
  Effect.gen(function* () {
    const events = yield* runV2(
      concurrentScript,
      "qwen-v2-concurrent",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    const linesA = progressFor(events, AGENT_A).join(" ");
    const linesB = progressFor(events, AGENT_B).join(" ");

    // Each agent's own words, on its own row.
    assert.include(linesA, "reading the diff", "agent A lost its first narration");
    assert.include(linesA, "three suspicious null checks", "A's post-B narration went to B");
    assert.include(linesB, "drafting the migration plan", "agent B lost its narration");

    // And NEITHER row carries the other's words — the exact cross-talk a single
    // window produces once the second root overwrites the first.
    assert.notInclude(linesA, "drafting the migration plan", "B's narration leaked onto A");
    assert.notInclude(linesB, "reading the diff", "A's narration leaked onto B");

    // Inner tools are attributed by their own tag too.
    const heartbeats = events.filter((e) => e.type === "tool.progress");
    const forA = heartbeats.filter((e) => e.payload.taskId === AGENT_A);
    const forB = heartbeats.filter((e) => e.payload.taskId === AGENT_B);
    assert.isAtLeast(forA.length, 1, "no heartbeat attributed to A");
    assert.isAtLeast(forB.length, 1, "no heartbeat attributed to B");
    assert.strictEqual(forA[0]!.payload.toolName, "read_file");
    assert.strictEqual(forB[0]!.payload.toolName, "write_file");

    // Running count: both roots open before either settles.
    const startedIdx = events.findIndex(
      (e) => e.type === "task.started" && e.payload.taskId === AGENT_B,
    );
    const settledIdx = events.findIndex(
      (e) => e.type === "task.completed" && e.payload.taskId === AGENT_A,
    );
    assert.isBelow(startedIdx, settledIdx, "B did not open before A settled — not concurrent");

    // The parent chat still only ever hears the parent.
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(concurrentScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. TAGGED THOUGHT CHUNKS.
//
// At v0.21.1 a child's thinking reaches the wire as `agent_thought_chunk`
// carrying `_meta.parentToolCallId` (SubAgentTracker.ts:304-310 → emitMessage's
// thought branch, MessageEmitter.ts:258-260 → :115-129). Our port drops the
// frame kind entirely (AcpRuntimeModel.ts:530-605 has no case; `default: break`
// at :603-604), so a tagged thought produces ZERO events today: the row shows
// nothing while the child thinks.
const thoughtScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitThought("weighing whether the null check is reachable at all", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff", "A done."))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("v2 · a child's TAGGED thought drives its row and never reaches the chat", () =>
  Effect.gen(function* () {
    const events = yield* runV2(
      thoughtScript,
      "qwen-v2-thought",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    assert.include(
      progressFor(events, AGENT_A).join(" "),
      "whether the null check is reachable",
      "a tagged thought chunk produced no row activity (the frame kind is dropped today)",
    );
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL, "the child's thinking leaked into the chat");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(thoughtScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. SIGNAL FRAMES.
//
// Three empty-text `agent_message_chunk`s whose entire payload is `_meta`
// (MessageEmitter.ts:37-86). Contract doc §9.1 settles what they mean: qwen's
// OWN reference host discards `stopHookLoop` as per-iteration noise
// (DaemonSessionProvider.tsx:3032-3043) and treats `goalTerminal`/`goalStatus`
// as required UI-state updates it explicitly exempts from turn-boundary
// suppression (:2707-2708).
//
// Today all three are absorbed inside parseSessionUpdateEvent before any event
// exists (empty text fails the `.length > 0` guard, no `_meta.usage` fails the
// usage guard) — so the goal frames are lost and, equally, nothing corrupts the
// chat. The first half is the gap; the second half must SURVIVE phase 3.
const GOAL_CONDITION = "all tests pass on the release branch";
const signalScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitSignalFrame({ kind: "goalStatus", status: { kind: "set", condition: GOAL_CONDITION } })
      .emitSignalFrame({
        kind: "stopHookLoop",
        iterationCount: 2,
        reasons: ["todo list still has open items"],
        stopHookCount: 1,
      })
      .emitSignalFrame({
        kind: "goalTerminal",
        terminal: {
          kind: "achieved",
          condition: GOAL_CONDITION,
          iterations: 3,
          durationMs: 4200,
        },
      })
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("v2 · goal signal frames are surfaced, stopHookLoop is dropped, chat stays clean", () =>
  Effect.gen(function* () {
    const events = yield* runV2(
      signalScript,
      "qwen-v2-signals",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    // The chat must contain the parent's words and NOTHING the signal frames
    // carried — this half passes today and is here to stay green through
    // phase 3 (an empty assistant bubble is the classic way to get this wrong).
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL, "a signal frame minted chat content");

    // stopHookLoop is inert telemetry: it must reach no surface at all.
    const carriesStopHook = events.some((e) => JSON.stringify(e).includes("stopHookLoop"));
    assert.isFalse(carriesStopHook, "stopHookLoop was surfaced — the reference host discards it");

    // TIGHTENED in phase 3 (this was a reachability assertion while the carrier
    // was undecided). Goals ride `runtime.warning`, which ingestion renders with
    // tone "info" using the adapter's own message as the row label
    // (ProviderRuntimeIngestion.ts:494-511) — a session notice, which is exactly
    // what a goal is. No new contract event was introduced for it.
    const notices = events.filter(
      (e): e is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
        e.type === "runtime.warning",
    );
    // Two frames in, two notices out: the `set` status and the `achieved`
    // terminal. A host that coalesced them would lose the fact a goal was set.
    assert.lengthOf(notices, 2, "expected one notice per goal frame");
    const messages = notices.map((e) => e.payload.message);
    assert.isTrue(
      messages.every((message) => message.includes(GOAL_CONDITION)),
      "a goal notice dropped the condition it is about",
    );
    // qwen's own vocabulary survives rather than being mapped to our words.
    assert.isTrue(messages.some((message) => message.includes("set")));
    assert.isTrue(messages.some((message) => message.includes("achieved")));
    // The raw payload rides `detail` so nothing qwen sent is lost.
    assert.isTrue(
      notices.every((e) => JSON.stringify(e.payload.detail ?? {}).includes(GOAL_CONDITION)),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(signalScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. rawOutput RECONCILIATION ON SETTLE.
//
// The Agent tool's terminal frame carries a SECOND, batched representation of
// the child's whole tool-call history in `rawOutput` (contract doc §2.5: the
// live per-call frames and this snapshot are the same history twice). Host
// obligation §7.4 names it explicitly as the reconciliation source "if
// live-streamed per-call updates were missed".
//
// Here the child's inner tool frames NEVER reach the wire (the sub-sub-agent
// gap of §9.2 is exactly this: nested detail surfaces only in the batched
// rawOutput). Today we read only `executionSummary` — `toolCalls` is ignored
// entirely — so the run settles claiming zero tool activity it demonstrably had.
const reconcileScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCallUpdate({
        toolCallId: AGENT_A,
        toolName: "agent",
        status: "completed",
        text: "Reviewed.",
        rawOutput: {
          type: "task_execution",
          subagentName: ROLE_A,
          taskDescription: "Review the diff",
          status: "completed",
          result: "Reviewed.",
          // The batched snapshot of work whose live frames were never sent.
          toolCalls: [
            { callId: "batched-1", name: "read_file", status: "success", description: "/a.ts" },
            { callId: "batched-2", name: "grep", status: "success", description: "null check" },
          ],
          executionSummary: { totalDurationMs: 900, totalToolCalls: 2, totalTokens: 700 },
        },
      })
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("v2 · a settle reconciles tool calls that were never streamed live", () =>
  Effect.gen(function* () {
    const events = yield* runV2(
      reconcileScript,
      "qwen-v2-reconcile",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    const completed = events.find(
      (e): e is TaskCompleted => e.type === "task.completed" && e.payload.taskId === AGENT_A,
    );
    assert.isDefined(completed, "no terminal for the agent");
    assert.strictEqual(completed!.payload.typedUsage?.toolUses, 2);

    // The reconciled calls must reach the row's OWN activity feed — the channel
    // the panel actually renders — not merely ride along inside the terminal
    // frame's opaque `data` bag.
    //
    // Asserting on `JSON.stringify(events)` here would be FALSE-GREEN and was:
    // `rawOutput` is folded verbatim into the item event's `data`
    // (AcpRuntimeModel.ts:350-361 → AcpCoreRuntimeEvents.ts:184), so every
    // batched id and tool name is already present in the serialized stream
    // while nothing reads them. Measured, not assumed — the first draft of this
    // spec passed on current main for exactly that reason.
    const heartbeatTools = events
      .filter((e) => e.type === "tool.progress" && e.payload.taskId === AGENT_A)
      .map((e) => (e as { payload: { toolName?: string } }).payload.toolName);
    assert.includeMembers(
      heartbeatTools,
      ["read_file", "grep"],
      "the batched tool-call snapshot never became row activity (only its COUNT was read)",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(reconcileScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. CRASH ≠ STOP.
//
// Today BOTH endings settle an open row with the identical
// `detail: "Stopped by the user."` (QwenAdapter.ts:951) and BOTH stamp
// `session.exited{exitKind:"graceful"}` (:1291-1297) — the contract defines
// `"error"` (providerRuntime.ts:106) but nothing ever emits it. A user whose
// CLI was OOM-killed is told they stopped it themselves.
const crashScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitText("A is partway through the review", META_A)
      .sleep(50)
      .exit(137),
};

it.effect("v2 · a crash settles the row differently from a user Stop, and marks the exit", () =>
  Effect.gen(function* () {
    const events = yield* runV2(crashScript, "qwen-v2-crash", (e) => e.type === "session.exited");

    const settled = events.find(
      (e): e is TaskCompleted => e.type === "task.completed" && e.payload.taskId === AGENT_A,
    );
    assert.isDefined(settled, "the crash left the agent row open");
    assert.strictEqual(settled!.payload.status, "stopped");
    // The row must not claim the USER stopped it.
    assert.notInclude(
      String(settled!.payload.detail ?? ""),
      "Stopped by the user",
      "a crash is reported to the user as their own Stop",
    );

    const exited = events.find((e) => e.type === "session.exited");
    assert.isDefined(exited);
    assert.strictEqual(
      (exited as { payload: { exitKind?: string } }).payload.exitKind,
      "error",
      "a crash-driven teardown still stamps exitKind:'graceful'",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(crashScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// 6. WINDOW MISS, CAUGHT BY THE TAG.
//
// The window heuristic's one structural failure: if the root frame is missed or
// dropped, there is no open window, and today a tagged child chunk falls
// straight through to the parent chat as ordinary `content.delta`
// (QwenAdapter.ts:2442-2460; flow doc §9.2 confirms "a tagged-but-window-missed
// chunk leaks into the main chat today, with no branch anywhere using the tag
// as a fallback"). At v0.21.1 the tag makes that recoverable.
//
// Scripted by emitting the child's tagged frames with NO root `tool_call` at
// all — the wire equivalent of a dropped opening frame.
const windowMissScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitText("the child speaks with no window ever opened", META_A)
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("v2 · a tagged chunk with no open window is attributed, not leaked to the chat", () =>
  Effect.gen(function* () {
    const events = yield* runV2(
      windowMissScript,
      "qwen-v2-window-miss",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(
      transcript,
      SENTINEL,
      "a tagged child chunk leaked into the parent chat because no window was open",
    );
    assert.include(
      progressFor(events, AGENT_A).join(" "),
      "with no window ever opened",
      "the tag was not used to recover attribution",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(windowMissScript), testServices)),
    TestClock.withLive,
  ),
);
