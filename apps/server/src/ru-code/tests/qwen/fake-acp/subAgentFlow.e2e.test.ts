// ru-code: END-TO-END qwen sub-agent attribution against the REAL wire shapes.
// The fake streams exactly what qwen 0.13.1 emits for one `agent` tool call —
// the agent tool_call, the child's inner tool frames tagged with
// `_meta.parentToolCallId`, the child's own usage chunk, and the agent's terminal
// tool_call_update carrying AgentResultDisplay. The adapter must turn that into:
//   · task.started / task.completed under the agent tool call id, taskType "subagent"
//   · tool.progress heartbeats naming the child's tools
//   · agentId + parentToolUseId on every item event of the run (incl. the agent row)
//   · NO thread.token-usage.updated for the child's tokens.
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
// ru-code: "Stopped by the user." is a localized WIRE string (dict "wire":
// true) — resolve to English before asserting the text (the suite runs in EN
// locale). resolveString is a no-op on plain strings, so it is safe on any
// value. Mirrors hiddenCompress.e2e.test.ts's enText helper.
import { resolveString } from "@ru-code/localization";
const enText = (value: unknown): string => resolveString(String(value), "en");

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-subagent-thread");
const AGENT_CALL = "call-agent-1";
const INNER_CALL = "call-inner-1";
const SUBAGENT_TYPE = "code-reviewer";
const SENTINEL = "SUBAGENT_FLOW_SENTINEL_DONE";
const THREAD_TOKENS = 1000;
const CHILD_TOKENS = 4321;

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-subagent-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const script: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      .emitUsageChunk(THREAD_TOKENS)
      .emitToolCall({
        toolCallId: AGENT_CALL,
        toolName: "agent",
        title: "Agent: Review the diff",
        rawInput: { description: "Review the diff", prompt: "p", subagent_type: SUBAGENT_TYPE },
      })
      .emitToolCall({
        toolCallId: INNER_CALL,
        toolName: "read_file",
        title: "ReadFile: /a.ts",
        status: "pending",
        kind: "read",
        rawInput: { absolute_path: "/a.ts" },
        subagentMeta: { parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
      })
      .emitSubAgentUsageChunk({
        inputTokens: CHILD_TOKENS,
        parentToolCallId: AGENT_CALL,
        subagentType: SUBAGENT_TYPE,
      })
      .emitToolCallUpdate({
        toolCallId: INNER_CALL,
        toolName: "read_file",
        status: "completed",
        text: "ok",
        subagentMeta: { parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
      })
      .emitToolCallUpdate({
        toolCallId: AGENT_CALL,
        toolName: "agent",
        status: "completed",
        text: "Found 2 issues.",
        rawOutput: {
          type: "task_execution",
          subagentName: SUBAGENT_TYPE,
          taskDescription: "Review the diff",
          taskPrompt: "p",
          status: "completed",
          result: "Found 2 issues.",
          executionSummary: {
            rounds: 3,
            totalDurationMs: 4200,
            totalToolCalls: 5,
            successfulToolCalls: 5,
            failedToolCalls: 0,
            successRate: 1,
            inputTokens: CHILD_TOKENS,
            outputTokens: 120,
            thoughtTokens: 7,
            cachedTokens: 100,
            totalTokens: 4441,
            toolUsage: [],
          },
        },
      })
      .emitText(SENTINEL)
      .respondOk(),
};

type TaskStarted = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
type TaskCompleted = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type ToolProgress = Extract<ProviderRuntimeEvent, { type: "tool.progress" }>;
type TokenUsage = Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;
type ItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

it.effect("qwen sub-agent run: task lifecycle, heartbeats, attributed items, isolated usage", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const sentinelSeen = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "content.delta" && event.payload.delta === SENTINEL
            ? Deferred.succeed(sentinelSeen, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "review the diff" });
    yield* Deferred.await(sentinelSeen).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // 1. The agent tool call opens a task, keyed by its own tool call id.
    const started = events.find((e): e is TaskStarted => e.type === "task.started");
    assert.isDefined(started, "no task.started for the agent tool call");
    assert.strictEqual(started!.payload.taskId, AGENT_CALL);
    assert.strictEqual(started!.payload.taskType, "subagent");
    assert.strictEqual(started!.payload.title, "Review the diff");
    assert.strictEqual(started!.payload.role, SUBAGENT_TYPE);
    assert.strictEqual(started!.payload.toolUseId, AGENT_CALL);

    // 2. Each inner frame produces a heartbeat naming the child's tool.
    const heartbeats = events.filter((e): e is ToolProgress => e.type === "tool.progress");
    assert.isAtLeast(heartbeats.length, 1, "no tool.progress heartbeat");
    for (const heartbeat of heartbeats) {
      assert.strictEqual(heartbeat.payload.taskId, AGENT_CALL);
      assert.strictEqual(heartbeat.payload.toolName, "read_file");
      assert.strictEqual(heartbeat.payload.toolUseId, INNER_CALL);
      assert.strictEqual(heartbeat.payload.parentToolUseId, AGENT_CALL);
    }

    // 3. The terminal frame closes the task with the final text and the usage.
    const completed = events.find((e): e is TaskCompleted => e.type === "task.completed");
    assert.isDefined(completed, "no task.completed for the agent tool call");
    assert.strictEqual(completed!.payload.taskId, AGENT_CALL);
    assert.strictEqual(completed!.payload.status, "completed");
    assert.strictEqual(completed!.payload.summary, "Found 2 issues.");
    assert.deepStrictEqual(completed!.payload.typedUsage, {
      totalTokens: 4441,
      inputTokens: CHILD_TOKENS,
      cachedInputTokens: 100,
      outputTokens: 120,
      reasoningOutputTokens: 7,
      toolUses: 5,
      durationMs: 4200,
    });

    // 4. Order: the task opens before its content and closes after it.
    assert.isBelow(events.indexOf(started!), events.indexOf(heartbeats[0]!));
    assert.isBelow(events.indexOf(heartbeats[0]!), events.indexOf(completed!));

    // 5. EVERY item event of the run is attributed — including the agent tool's own
    //    row, which would otherwise render a second, duplicate chat row.
    const runItems = events.filter(
      (e): e is ItemEvent =>
        (e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") &&
        (e.itemId === AGENT_CALL || e.itemId === INNER_CALL),
    );
    assert.isAtLeast(runItems.length, 3);
    for (const item of runItems) {
      assert.strictEqual(item.payload.agentId, AGENT_CALL);
      assert.strictEqual(item.payload.parentToolUseId, AGENT_CALL);
    }

    // 6. The child's tokens NEVER move the thread meter (they also feed the
    //    auto-compaction trigger, so a leak here compacts the wrong context).
    const usageEvents = events.filter(
      (e): e is TokenUsage => e.type === "thread.token-usage.updated",
    );
    assert.lengthOf(usageEvents, 1);
    assert.strictEqual(usageEvents[0]!.payload.usage.usedTokens, THREAD_TOKENS);
    assert.isUndefined(
      usageEvents.find((e) => e.payload.usage.usedTokens === CHILD_TOKENS),
      "a sub-agent's prompt tokens reached the thread meter",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// ru-code (sub-agents, narration): the flow the first case does NOT cover — the
// child's own words. qwen strips sub-agent `_meta` off text/thought/plan frames
// (SubAgentTracker.ts:275), so they arrive anonymous and used to be spliced into
// the PARENT's chat bubble. The window between a root `agent` tool_call and its
// settling update attributes them with certainty (strict serialization:
// Session.ts:166-197 / :353-359 / :881), so all of it must land on the agent row
// instead. Two agents run back-to-back in ONE turn to prove the window closes.
const AGENT_CALL_B = "call-agent-2";
const INNER_CALL_B = "call-inner-2";
const SUBAGENT_TYPE_B = "planner";
const PARENT_OPENING = "Spawning two agents now. ";
const CHILD_A_1 = "Reading the diff and looking for missing null checks";
const CHILD_A_2 = " — three files touched, one suspicious.";
const CHILD_A_THOUGHT = "the reviewer is thinking about edge cases";
const CHILD_B_TEXT = "Drafting the migration plan before anything is written down.";
const INNER_RESULT = "42 lines";

const narrationScript: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      .emitUsageChunk(THREAD_TOKENS)
      // Parent's own text — BEFORE any window is open, so it is the parent's.
      .emitText(PARENT_OPENING)
      // ── agent A ───────────────────────────────────────────────────────────
      .emitToolCall({
        toolCallId: AGENT_CALL,
        toolName: "agent",
        title: "Agent: Review the diff",
        rawInput: { description: "Review the diff", prompt: "p", subagent_type: SUBAGENT_TYPE },
      })
      // Unstamped thought + text: the child's, by the window.
      .emitThought(CHILD_A_THOUGHT)
      .emitText(CHILD_A_1)
      .emitText(CHILD_A_2)
      // The CHILD's todo list — must not replace the parent's task list.
      .emitPlan([
        { content: "read the files", status: "completed" },
        { content: "write the review", status: "in_progress" },
      ])
      .emitToolCall({
        toolCallId: INNER_CALL,
        toolName: "read_file",
        title: "ReadFile: /a.ts",
        status: "pending",
        kind: "read",
        rawInput: { absolute_path: "/a.ts" },
        subagentMeta: { parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
      })
      .emitToolCallUpdate({
        toolCallId: INNER_CALL,
        toolName: "read_file",
        status: "completed",
        text: INNER_RESULT,
        subagentMeta: { parentToolCallId: AGENT_CALL, subagentType: SUBAGENT_TYPE },
      })
      .emitSubAgentUsageChunk({
        inputTokens: CHILD_TOKENS,
        parentToolCallId: AGENT_CALL,
        subagentType: SUBAGENT_TYPE,
      })
      .emitToolCallUpdate({
        toolCallId: AGENT_CALL,
        toolName: "agent",
        status: "completed",
        text: "Found 2 issues.",
        rawOutput: {
          type: "task_execution",
          subagentName: SUBAGENT_TYPE,
          taskDescription: "Review the diff",
          status: "completed",
          result: "Found 2 issues.",
          executionSummary: { totalDurationMs: 4200, totalToolCalls: 5, totalTokens: 4441 },
        },
      })
      // ── agent B, strictly after A settled — a SECOND, disjoint window ─────
      .emitToolCall({
        toolCallId: AGENT_CALL_B,
        toolName: "agent",
        title: "Agent: Plan the migration",
        rawInput: {
          description: "Plan the migration",
          prompt: "p2",
          subagent_type: SUBAGENT_TYPE_B,
        },
      })
      .emitText(CHILD_B_TEXT)
      .emitToolCall({
        toolCallId: INNER_CALL_B,
        toolName: "write_file",
        title: "WriteFile: /plan.md",
        status: "pending",
        kind: "edit",
        rawInput: { absolute_path: "/plan.md" },
        subagentMeta: { parentToolCallId: AGENT_CALL_B, subagentType: SUBAGENT_TYPE_B },
      })
      // Ending #1 — PROTOCOL CANCEL: qwen still emits the settling frame, with
      // status 'cancelled' + terminateReason (qwen-code tools/agent.ts:634-641).
      .emitToolCallUpdate({
        toolCallId: AGENT_CALL_B,
        toolName: "agent",
        status: "completed",
        rawOutput: {
          type: "task_execution",
          subagentName: SUBAGENT_TYPE_B,
          taskDescription: "Plan the migration",
          status: "cancelled",
          result: "Partial plan: 2 of 5 steps.",
          terminateReason: "CANCELLED",
          executionSummary: { totalDurationMs: 900, totalToolCalls: 1, totalTokens: 700 },
        },
      })
      // Parent again — the window is closed, so this is chat text.
      .emitText(SENTINEL)
      .respondOk(),
};

type ContentDelta = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
type PlanUpdated = Extract<ProviderRuntimeEvent, { type: "turn.plan.updated" }>;
type TaskProgress = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;

const runScript = (threadId: ThreadId, prompt: string, sentinel: string | null) =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          (
            sentinel === null
              ? event.type === "session.exited"
              : event.type === "content.delta" && event.payload.delta === sentinel
          )
            ? Deferred.succeed(done, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    // A scripted process death fails the prompt; the events are the subject here.
    yield* Effect.exit(adapter.sendTurn({ threadId, input: prompt }));
    yield* Deferred.await(done).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);
    return events;
  });

it.effect(
  "qwen sub-agent narration: child text/thought/plan never reach the chat, they drive the row",
  () =>
    Effect.gen(function* () {
      const events = yield* runScript(
        ThreadId.make("qwen-subagent-narration-thread"),
        "review then plan",
        SENTINEL,
      );

      // 1. THE headline: the chat transcript is the PARENT's words and nothing
      //    else. Concatenating every delta is stricter than a substring check —
      //    it also catches a child chunk that merely arrived out of order.
      const transcript = events
        .filter((e): e is ContentDelta => e.type === "content.delta")
        .map((e) => e.payload.delta)
        .join("");
      assert.strictEqual(transcript, `${PARENT_OPENING}${SENTINEL}`);
      for (const leak of [CHILD_A_1, CHILD_A_2, CHILD_A_THOUGHT, CHILD_B_TEXT]) {
        assert.notInclude(transcript, leak, "a child's narration reached the main chat");
      }

      // 2. The CHILD's plan did not replace the parent's task list. The parent
      //    never sent a plan of its own in this script, so ANY plan event is the
      //    child's leaking through.
      assert.lengthOf(
        events.filter((e): e is PlanUpdated => e.type === "turn.plan.updated"),
        0,
        "the child's todo list overwrote the parent's task list surface",
      );

      // 3. The row's live line moves WHILE the child runs, on the one channel the
      //    panel reads (subagentRuntime.ts:519-527 → RuntimeSubagent.progress).
      const progress = events.filter((e): e is TaskProgress => e.type === "task.progress");
      const linesFor = (taskId: string) =>
        progress
          .filter((e) => e.payload.taskId === taskId)
          .map((e) => e.payload.summary)
          .filter((summary): summary is string => summary !== undefined);
      const linesA = linesFor(AGENT_CALL);
      assert.isAtLeast(linesA.length, 2, "the agent row never got a live line");
      assert.include(linesA[0]!, "Reading the diff");
      // Every line is bounded to what the fold will keep (SUMMARY_CHAR_LIMIT).
      for (const line of [...linesA, ...linesFor(AGENT_CALL_B)]) {
        assert.isAtMost(line.length, 180);
      }
      // The child's plan is PARKED on the row: count + the live step.
      assert.isTrue(
        linesA.some((line) => line.includes("▤ 1/2") && line.includes("write the review")),
        "the child's plan was not parked on the agent row",
      );
      // The inner tool's own RESULT rides the same channel (tool.progress cannot
      // carry it — the fold reads only a tool NAME from that arm).
      assert.isTrue(
        linesA.some((line) => line.includes("▸ read_file") && line.includes(INNER_RESULT)),
        "the inner tool's result was dropped",
      );
      // Every progress row re-stamps the agent linkage, so a fold that missed the
      // start row still classifies the task as an agent.
      for (const event of progress) {
        assert.strictEqual(event.payload.taskType, "subagent");
        assert.isDefined(event.payload.description);
      }

      // 4. Attribution is PER WINDOW: agent B's text landed on agent B, and the
      //    parent's closing sentinel landed on neither.
      const linesB = linesFor(AGENT_CALL_B);
      assert.isAtLeast(linesB.length, 1, "the second agent got no live line");
      assert.include(linesB.join(" "), "Drafting the migration plan");
      assert.notInclude(linesA.join(" "), "Drafting the migration plan");
      assert.strictEqual(
        progress.filter((e) => (e.payload.summary ?? "").includes(SENTINEL)).length,
        0,
        "parent text after the window closed was attributed to an agent",
      );
      assert.strictEqual(
        progress.filter((e) => (e.payload.summary ?? "").includes(PARENT_OPENING.trim())).length,
        0,
        "parent text before the window opened was attributed to an agent",
      );

      // 5. Both agents settled, each under its own task id — and ENDING #1, the
      //    protocol cancel, is a STOP carrying qwen's own reason.
      const completions = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          e.type === "task.completed",
      );
      const completedA = completions.find((e) => e.payload.taskId === AGENT_CALL);
      const completedB = completions.find((e) => e.payload.taskId === AGENT_CALL_B);
      assert.isDefined(completedA);
      assert.strictEqual(completedA!.payload.status, "completed");
      assert.strictEqual(completedA!.payload.summary, "Found 2 issues.");
      assert.strictEqual(completedA!.payload.typedUsage?.totalTokens, 4441);
      assert.isDefined(completedB);
      assert.strictEqual(completedB!.payload.status, "stopped");
      // The partial result is the row's text; qwen's own reason for the early
      // exit rides `detail` instead of being dropped.
      assert.strictEqual(completedB!.payload.summary, "Partial plan: 2 of 5 steps.");
      assert.strictEqual(completedB!.payload.detail, "CANCELLED");

      // 6. The child's tokens still never move the thread meter.
      const usage = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          e.type === "thread.token-usage.updated",
      );
      assert.isTrue(usage.every((e) => e.payload.usage.usedTokens !== CHILD_TOKENS));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(narrationScript), testServices)),
      TestClock.withLive,
    ),
);

// ru-code (sub-agents / P2 zombie settle): ENDING #2 — the ACP process DIES
// mid-run. qwen emits no settling frame at all — the crash-driven teardown
// (childExitObserved → scheduleTeardown → abortSession → abortSessionTeardown)
// now calls `settleOpenSubAgentAsStopped(ctx)` before it interrupts the
// notification fiber, so the row is settled SERVER-SIDE with a real persisted
// `task.completed{status:"stopped"}` — no longer left to the client's
// sessionLive:false sweep (which stays as pure belt-and-braces: a client that
// reloads before this row lands still must not read the row as forever-running).
const deadAcpScript: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      .emitToolCall({
        toolCallId: AGENT_CALL,
        toolName: "agent",
        title: "Agent: Review the diff",
        rawInput: { description: "Review the diff", prompt: "p", subagent_type: SUBAGENT_TYPE },
      })
      .emitText(CHILD_A_1)
      // Let the notifications reach the client before the pipe dies — a real
      // crash is not synchronous with the last frame it managed to write.
      .sleep(50)
      .exit(137),
};

it.effect("qwen sub-agent: a dead ACP is settled server-side (P2 zombie fix)", () =>
  Effect.gen(function* () {
    const events = yield* runScript(
      ThreadId.make("qwen-subagent-dead-acp-thread"),
      "review the diff",
      null,
    );

    const started = events.filter(
      (e): e is Extract<ProviderRuntimeEvent, { type: "task.started" }> =>
        e.type === "task.started",
    );
    assert.lengthOf(started, 1);
    assert.strictEqual(started[0]!.payload.taskId, AGENT_CALL);

    // No settling frame from qwen — but the crash teardown's own
    // settleOpenSubAgentAsStopped now closes the row with a terminal
    // `task.completed{status:"stopped"}` before session.exited (I5-style
    // ordering, mirrored from the turn-finalizer barrier).
    // (Scoped to the AGENT's task id: the crash itself surfaces as its own
    // `task.completed` error row — the error engine's B1 notification.)
    const settled = events.filter(
      (e): e is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
        e.type === "task.completed" && e.payload.taskId === AGENT_CALL,
    );
    assert.lengthOf(settled, 1, "the crash teardown did not settle the open agent row");
    assert.strictEqual(settled[0]!.payload.status, "stopped");
    assert.strictEqual(settled[0]!.payload.taskType, "subagent");
    assert.strictEqual(enText(settled[0]!.payload.detail), "Stopped by the user.");
    assert.isBelow(
      events.indexOf(settled[0]!),
      events.findIndex((e) => e.type === "session.exited"),
      "the settle must land before session.exited",
    );

    // The child's last words survived the death (the window flushes below the
    // quantum only at settle, but a full quantum was already published here).
    const lines = events
      .filter((e): e is TaskProgress => e.type === "task.progress")
      .map((e) => e.payload.summary ?? "");
    assert.isTrue(
      lines.some((line) => line.includes("Reading the diff")),
      "the child's narration was lost when the process died",
    );
    // The flush is idempotent: already-published narration must not repeat
    // (takeQwenAgentLine returns undefined when nothing new accumulated).
    assert.strictEqual(
      events.filter(
        (e) => e.type === "task.progress" && (e.payload.summary ?? "").includes("Reading the diff"),
      ).length,
      1,
      "the settle re-flushed narration that was already published",
    );

    // session.exited still fires (kept as the client sweep's trigger — pure
    // belt-and-braces now, load-bearing only before this row lands).
    assert.isAtLeast(
      events.filter((e) => e.type === "session.exited").length,
      1,
      "no session.exited",
    );

    // And it never leaked into the chat on the way out.
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.notInclude(transcript, CHILD_A_1);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(deadAcpScript), testServices)),
    TestClock.withLive,
  ),
);

// ru-code (P2 zombie settle): ENDING #3 — the owner's STOP while an agent root
// is open. Unlike ENDING #1 (qwen's own protocol-cancel settling frame still
// arrives), a Stop-button teardown interrupts the notification fiber BEFORE
// any settling frame can be drained — this is the exact bug the fix closes:
// `settleOpenSubAgentAsStopped` makes the wire carry a terminal
// `task.completed{status:"stopped"}` even though qwen itself never sent one.
const stopMidAgentScript: FakeAcpScript = {
  onPrompt: (steps) =>
    // No terminal response after the tool call — the prompt parks until
    // `session/cancel` resolves it (mirrors cancelThenKill.e2e.test.ts).
    steps.emitToolCall({
      toolCallId: AGENT_CALL,
      toolName: "agent",
      title: "Agent: Review the diff",
      rawInput: { description: "Review the diff", prompt: "p", subagent_type: SUBAGENT_TYPE },
    }),
};

it.effect(
  "qwen sub-agent: Stop while an agent root is open settles it server-side (ENDING #3)",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const threadId = ThreadId.make("qwen-subagent-stop-thread");
      const events: ProviderRuntimeEvent[] = [];
      const agentStarted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "task.started" && event.payload.taskId === AGENT_CALL
              ? Deferred.succeed(agentStarted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId, input: "review the diff" }),
      );
      yield* Deferred.await(agentStarted).pipe(Effect.timeout("10 seconds"));

      yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      const settled = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          e.type === "task.completed" && e.payload.taskId === AGENT_CALL,
      );
      assert.lengthOf(settled, 1, "Stop did not settle the open agent row");
      assert.strictEqual(settled[0]!.payload.status, "stopped");
      assert.strictEqual(settled[0]!.payload.taskType, "subagent");
      assert.strictEqual(settled[0]!.payload.toolUseId, AGENT_CALL);
      assert.strictEqual(enText(settled[0]!.payload.detail), "Stopped by the user.");
      assert.isBelow(
        events.indexOf(settled[0]!),
        events.findIndex((e) => e.type === "session.exited"),
        "the settle must land before session.exited",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(stopMidAgentScript), testServices)),
      TestClock.withLive,
    ),
);
