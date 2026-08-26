// ru-code (agents wave, phase 4): the specs Seat B's audit proved were missing.
//
// Every case here corresponds to a finding whose mutation the ENTIRE server
// suite failed to notice — i.e. behaviour the wave claimed in prose and left
// unguarded. Four are Seat B's own probes (B-1, f-2, f-3, f-4), which it wrote,
// ran and handed over; the rest close the blind mutations in its evidence ledger
// (f-10, f-11, f-12, f-13).
//
// Dialect v2 throughout: these are 0.21.1 contract claims.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  QwenSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import {
  QWEN_MAX_OPEN_AGENT_WINDOWS,
  QWEN_MAX_SETTLED_AGENT_IDS,
} from "../../../qwen/acp/QwenAcpSubAgents.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-audit-fix-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const AGENT_A = "call-agent-A";
const AGENT_B = "call-agent-B";
const AGENT_C = "call-agent-C";
const INNER_A = "call-inner-A";
const ROLE_A = "code-reviewer";
const ROLE_B = "planner";
const SENTINEL = "AUDIT_FIX_SENTINEL";
const META_A = { parentToolCallId: AGENT_A, subagentType: ROLE_A };
const META_B = { parentToolCallId: AGENT_B, subagentType: ROLE_B };

// ru-code (f-15): 30s, not 10s. Seat B measured the 10s bound flaking on a cold
// run whose transform+import alone took 26.5s — a gate that reads green only on
// a warm machine is not a gate.
const SETTLE_TIMEOUT = "30 seconds";

type TaskProgress = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
type ContentDelta = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;

const agentRoot = (callId: string, description: string, role: string) => ({
  toolCallId: callId,
  toolName: "agent",
  title: `Agent: ${description}`,
  rawInput: { description, prompt: "p", subagent_type: role, run_in_background: false },
});

const agentSettle = (callId: string, role: string, description: string, extras?: unknown) => ({
  toolCallId: callId,
  toolName: "agent",
  status: "completed" as const,
  text: "done.",
  rawOutput: {
    type: "task_execution",
    subagentName: role,
    taskDescription: description,
    status: "completed",
    result: "done.",
    ...(extras !== undefined ? (extras as Record<string, unknown>) : {}),
    executionSummary: { totalDurationMs: 100, totalToolCalls: 1, totalTokens: 10 },
  },
});

const run = (
  script: FakeAcpScript,
  threadId: string,
  isDone: (event: ProviderRuntimeEvent) => boolean,
  // ru-code (phase 4b, R-4): a permission-gated spawn PARKS the agent's script
  // until the client answers — that is the whole point of the gate. A script
  // carrying one therefore needs the test to play the user who clicks Allow, or
  // nothing after the gate ever reaches the wire.
  options: { readonly approveRequests?: boolean } = {},
) =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const done = yield* Deferred.make<void>();
    const id0 = ThreadId.make(threadId);
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          options.approveRequests === true && event.type === "request.opened"
            ? adapter
                .respondToRequest(
                  id0,
                  ApprovalRequestId.make(String((event as { requestId?: unknown }).requestId)),
                  "accept",
                )
                .pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.andThen(isDone(event) ? Deferred.succeed(done, undefined) : Effect.void),
      ),
    ).pipe(Effect.forkChild);
    const id = id0;
    yield* adapter.startSession({
      threadId: id,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* Effect.exit(adapter.sendTurn({ threadId: id, input: "go" }));
    yield* Deferred.await(done).pipe(Effect.timeout(SETTLE_TIMEOUT));
    yield* Fiber.interrupt(fiber);
    return events;
  });

const lifecycleOf = (events: ReadonlyArray<ProviderRuntimeEvent>, taskId: string) =>
  events
    .filter(
      (e) =>
        (e.type === "task.started" || e.type === "task.completed") &&
        (e as { payload: { taskId?: string } }).payload.taskId === taskId,
    )
    .map((e) => e.type);

const progressFor = (events: ReadonlyArray<ProviderRuntimeEvent>, taskId: string) =>
  events
    .filter((e): e is TaskProgress => e.type === "task.progress" && e.payload.taskId === taskId)
    .map((e) => e.payload.summary ?? "")
    .filter((line) => line.length > 0);

// ─────────────────────────────────────────────────────────────────────────────
// B-1 (BLOCKER) — Seat B's PROBE 1.
//
// qwen fires the child's emitters UNAWAITED (SAT:143, SAT:304) while the Agent
// tool's own terminal frame is awaited on a different stack (SE:8216), so a
// child's last chunk can legitimately land AFTER its parent's settle. Before the
// fix, "no window for this tag" was also the state a settle leaves behind, so
// the straggler was adopted as a brand-new run: a second `task.started` for a
// taskId that had already completed. User-visible effect — a green Completed row
// flips back to Working and the session ends showing it as Stopped.
const stragglerScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitText("A is reviewing the diff at some length", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      // The straggler: same tag, after the settle.
      .emitText("A's last words, arriving late", META_A)
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("B-1 · a tagged straggler does NOT resurrect an agent that already completed", () =>
  Effect.gen(function* () {
    const events = yield* run(
      stragglerScript,
      "qwen-audit-straggler",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );

    assert.deepStrictEqual(
      lifecycleOf(events, AGENT_A),
      ["task.started", "task.completed"],
      "a post-settle tagged chunk re-opened the agent",
    );
    // And the straggler is DROPPED rather than re-routed somewhere else: it must
    // not appear on the row (the run is over) nor in the chat (it is the child's).
    assert.notInclude(progressFor(events, AGENT_A).join(" "), "last words");
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL, "a settled agent's straggler leaked into the chat");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(stragglerScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-2 — Seat B's PROBE 2. Draining only the FIRST window (the exact concurrency
// bug the change was made for) was invisible to all 540 specs.
const twoOpenThenCrash: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall(agentRoot(AGENT_B, "Plan the migration", ROLE_B))
      .emitText("A speaking", META_A)
      .sleep(50)
      .exit(137),
};

it.effect("f-2 · a teardown with two agents open settles BOTH rows, not just the first", () =>
  Effect.gen(function* () {
    const events = yield* run(
      twoOpenThenCrash,
      "qwen-audit-drain-all",
      (e) => e.type === "session.exited",
    );
    const settled = events
      .filter((e) => e.type === "task.completed")
      .map((e) => (e as { payload: { taskId?: string } }).payload.taskId);
    assert.includeMembers(
      settled,
      [AGENT_A, AGENT_B],
      "a teardown left one of two open agents as a permanent Working zombie",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(twoOpenThenCrash), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-3 — Seat B's PROBE 3. Matrix #4 proves the LOSS direction (batched calls must
// become row activity); this proves the other half the report claimed and never
// guarded — a call seen live is not replayed at settle.
const liveAndRolledUp: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall({
        toolCallId: INNER_A,
        toolName: "read_file",
        title: "read_file: /a.ts",
        status: "pending",
        kind: "read",
        rawInput: { absolute_path: "/a.ts" },
        subagentMeta: META_A,
      })
      .emitToolCallUpdate(
        agentSettle(AGENT_A, ROLE_A, "Review the diff", {
          // The SAME call, also present in the rollup — qwen sends both
          // representations (contract §2.5), and `agent.ts:1371-1372` proves the
          // rollup's callId IS the wire toolCallId, so the dedupe key matches.
          toolCalls: [{ callId: INNER_A, name: "read_file", status: "success" }],
        }),
      )
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("f-3 · a call seen live is not replayed by the settle's rollup", () =>
  Effect.gen(function* () {
    const events = yield* run(
      liveAndRolledUp,
      "qwen-audit-no-double",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    const heartbeats = events.filter(
      (e) =>
        e.type === "tool.progress" &&
        (e as { payload: { toolUseId?: string } }).payload.toolUseId === INNER_A,
    );
    assert.lengthOf(heartbeats, 1, "the settle replayed a tool call that was already published");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(liveAndRolledUp), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-14 — the other half of reconciliation: entries the rollup still shows as
// IN FLIGHT must NOT be replayed. qwen seeds every entry `status:'executing'`
// at call start (agent.ts:1372-1376), so a cancelled child's rollup carries
// work that never completed.
const rollupWithInFlight: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCallUpdate(
        agentSettle(AGENT_A, ROLE_A, "Review the diff", {
          toolCalls: [
            { callId: "done-1", name: "read_file", status: "success" },
            { callId: "inflight-1", name: "write_file", status: "executing" },
            { callId: "parked-1", name: "shell", status: "awaiting_approval" },
          ],
        }),
      )
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("f-14 · the settle replays only FINISHED rollup entries, never in-flight ones", () =>
  Effect.gen(function* () {
    const events = yield* run(
      rollupWithInFlight,
      "qwen-audit-inflight-rollup",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    const replayed = events
      .filter((e) => e.type === "tool.progress")
      .map((e) => (e as { payload: { toolUseId?: string } }).payload.toolUseId);
    assert.include(replayed, "done-1", "a finished rollup entry was not reconciled");
    assert.notInclude(replayed, "inflight-1", "an unfinished tool call was replayed as activity");
    assert.notInclude(
      replayed,
      "parked-1",
      "an approval-parked tool call was replayed as activity",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(rollupWithInFlight), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-4 — Seat B's PROBE 4. Matrix #6 asserts `task.progress` off the SERVER
// stream, which the adapter emits regardless; the client fold drops a heartbeat
// for a task it never saw open, so the panel would show nothing while the spec
// stayed green. The `task.started` is what makes the row exist.
const orphanScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitText("the child speaks with no window ever opened", META_A)
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("f-4 · adopting an orphan emits the task.started the fold needs to render a row", () =>
  Effect.gen(function* () {
    const events = yield* run(
      orphanScript,
      "qwen-audit-orphan-started",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    const started = events.filter(
      (e) =>
        e.type === "task.started" &&
        (e as { payload: { taskId?: string } }).payload.taskId === AGENT_A,
    );
    assert.lengthOf(started, 1, "the adopted orphan has no task.started — the panel stays empty");
    assert.strictEqual(
      (started[0] as { payload: { role?: string } }).payload.role,
      ROLE_A,
      "the adopted row lost the only identity the tag carried",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(orphanScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-10 — the invariant `resolveQwenAgentWindow`'s own doc states: a tagged frame
// whose window is gone must NOT fall back to the serial window, or a straggler
// lands on a live sibling. B-1 covers the SETTLED case; this covers the sibling
// case that makes the misattribution visible.
const stragglerWithLiveSibling: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall(agentRoot(AGENT_B, "Plan the migration", ROLE_B))
      .emitText("B is planning", META_B)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      // A is settled; B is still open. A's straggler must reach NEITHER.
      .emitText("A's straggler must not land on B", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_B, ROLE_B, "Plan the migration"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("f-10 · a settled agent's straggler is not misattributed to a live sibling", () =>
  Effect.gen(function* () {
    const events = yield* run(
      stragglerWithLiveSibling,
      "qwen-audit-straggler-sibling",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    assert.notInclude(
      progressFor(events, AGENT_B).join(" "),
      "straggler",
      "a settled agent's late chunk was attributed to a live sibling",
    );
    assert.deepStrictEqual(lifecycleOf(events, AGENT_A), ["task.started", "task.completed"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(stragglerWithLiveSibling), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-11 — the serial window follows the NEWEST open sibling. It matters because
// plans and permission requests are the two frame kinds upstream leaves untagged
// (PE:27-39, SAT:223-226), so the serial window is their ONLY signal: pointing
// it at the wrong sibling silently parks a child's plan on another agent's row.
const serialFollowsNewest: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall(agentRoot(AGENT_B, "Plan the migration", ROLE_B))
      .emitToolCall(agentRoot(AGENT_C, "Write the tests", "tester"))
      // C is newest. Settling it must hand the serial signal back to B, not A.
      .emitToolCallUpdate(agentSettle(AGENT_C, "tester", "Write the tests"))
      .emitPlan([
        { content: "read the files", status: "completed" },
        { content: "write the review", status: "in_progress" },
      ])
      .emitToolCallUpdate(agentSettle(AGENT_B, ROLE_B, "Plan the migration"))
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("f-11 · after a settle the serial window follows the NEWEST sibling still open", () =>
  Effect.gen(function* () {
    const events = yield* run(
      serialFollowsNewest,
      "qwen-audit-serial-newest",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    // The untagged plan belongs to B (newest open after C settled), not A.
    assert.isTrue(
      progressFor(events, AGENT_B).some((line) => line.includes("▤ 1/2")),
      "the child's plan did not land on the newest open sibling",
    );
    assert.isFalse(
      progressFor(events, AGENT_A).some((line) => line.includes("▤ 1/2")),
      "the child's plan landed on the OLDEST open agent instead of the newest",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(serialFollowsNewest), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-1 — the behavioural half. `SE:7893` emits an untagged, NON-EMPTY
// agent_message_chunk from inside the concurrent agent batch (a PreToolUse-blocked
// notice), i.e. with a window open. It is the PARENT's text and must reach the
// chat — not be appended to whichever agent happens to be open — and it must
// carry an itemId like any other assistant delta.
const untaggedNoticeDuringAgent: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      // No child text yet — this is exactly the window in which the old
      // "have we seen a tagged text chunk" latch was still false.
      .emitText("✗ **PreToolUse blocked**: write_file denied by hook")
      .emitText("A is reviewing", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect(
  "f-1 · an untagged notice during an open agent is the PARENT's, and keeps its itemId",
  () =>
    Effect.gen(function* () {
      const events = yield* run(
        untaggedNoticeDuringAgent,
        "qwen-audit-untagged-notice",
        (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
      );
      // (a) never appended to the agent's live line
      assert.notInclude(
        progressFor(events, AGENT_A).join(" "),
        "PreToolUse blocked",
        "a parent notice was rendered as the agent's own narration",
      );
      // (b) reaches the chat
      const deltas = events.filter((e): e is ContentDelta => e.type === "content.delta");
      const notice = deltas.find((e) => e.payload.delta.includes("PreToolUse blocked"));
      assert.isDefined(notice, "the parent's notice never reached the chat");
      // (c) with an itemId — the segment guard must not have suppressed it.
      // `itemId` is a TOP-LEVEL field on the event (AcpCoreRuntimeEvents.ts:231),
      // not a payload key.
      assert.isDefined(
        notice!.itemId,
        "the parent's notice reached the chat with no itemId (segment suppressed for an open window)",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(fakeAcpSpawnerLayer(untaggedNoticeDuringAgent), testServices),
      ),
      TestClock.withLive,
    ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-13 — the tagged-frame clause in the segment guard. Seat B could not tell
// whether it was dead or merely untested. It is NOT dead: on the orphan path no
// window is open, so without the clause the runtime mints an assistant segment
// for a chunk the adapter then re-routes to the agent row, leaving an empty
// assistant bubble in the chat.
// NOTE on the script: it carries ONLY the orphan's tagged chunk and no parent
// text at all. An earlier version reused `orphanScript` (which ends with a
// sentinel) and asserted "at most one assistant item" — that could not
// discriminate, because `ensureActiveAssistantSegment` REUSES the open segment,
// so the sentinel's own legitimate item made the count 1 either way. Measured:
// dropping the clause left that version green. With no parent text, ANY
// assistant item is spurious.
const orphanOnlyScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) => steps.emitText("orphan speaks, nobody else does", META_A).respondOk(),
};

it.effect("f-13 · an orphan-adopted chunk mints no assistant item in the chat", () =>
  Effect.gen(function* () {
    const events = yield* run(
      orphanOnlyScript,
      "qwen-audit-orphan-segment",
      (e) => e.type === "turn.completed",
    );
    assert.lengthOf(
      events.filter((e) => e.type === "item.started"),
      0,
      "the orphan's chunk minted an assistant segment — an empty bubble in the chat",
    );
    // …and it did reach the row, so the absence above is suppression, not loss.
    assert.include(progressFor(events, AGENT_A).join(" "), "orphan speaks");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(orphanOnlyScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// f-12 — the window cap. Seat B found eviction unspecced, silently orphaning a
// row and leaking its bookkeeping. Eleven roots open against a cap of ten: the
// OLDEST is evicted and must be closed with a real terminal, not vanish.
const overflowScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) => {
    let chain = steps;
    for (let index = 0; index < QWEN_MAX_OPEN_AGENT_WINDOWS + 1; index += 1) {
      chain = chain.emitToolCall(agentRoot(`call-agent-${index}`, `Task ${index}`, ROLE_A));
    }
    chain.emitText(SENTINEL).respondOk();
  },
};

it.effect("f-12 · exceeding the window cap CLOSES the evicted row instead of orphaning it", () =>
  Effect.gen(function* () {
    const events = yield* run(
      overflowScript,
      "qwen-audit-cap-evict",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    // The oldest (index 0) is the one evicted, and it must carry a terminal.
    assert.deepStrictEqual(
      lifecycleOf(events, "call-agent-0"),
      ["task.started", "task.completed"],
      "the evicted agent never got a terminal — its row hangs on Working",
    );
    const evicted = events.find(
      (e) =>
        e.type === "task.completed" &&
        (e as { payload: { taskId?: string } }).payload.taskId === "call-agent-0",
    );
    assert.strictEqual((evicted as { payload: { status?: string } }).payload.status, "stopped");
    // The newest must NOT be the one evicted.
    assert.deepStrictEqual(lifecycleOf(events, `call-agent-${QWEN_MAX_OPEN_AGENT_WINDOWS}`), [
      "task.started",
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(overflowScript), testServices)),
    TestClock.withLive,
  ),
);

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 2 — findings on the round-1 fix diff.
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// R-4 — THE PERMISSION-GATED SPAWN: the product's DEFAULT wire, unmodelled until
// now. Every agent spec in phases 1-4 scripted a spawn `tool_call`; that frame
// does not exist in `approval-required`.
//
// Chain, each link opened: `AgentTool.getDefaultPermission()` → `'ask'`
// (agent.ts:1566-1568); `resolveQwenMode` returns only plan|auto-edit|default,
// never yolo/auto (QwenAdapter.ts:666-674); so `didRequestPermission = true`
// (SE:7651) and `SE:7861`'s `if (!didRequestPermission && !isTodoWriteTool)`
// skips `emitStart` — qwen's own comment there reads "Auto-approved (L3 allow /
// L4 PM allow / L5 YOLO|AUTO_EDIT)". The spawn reaches us only as
// `session/request_permission`, and the run is otherwise ROOTLESS.
//
// ru-code (agentic-flow wave, FIX ROUND 3, F-A3): THIS PARAGRAPH USED TO READ
// "in the default mode ORPHAN ADOPTION IS THE PRIMARY BIRTH PATH, not a
// recovery corner", and that is no longer true. The permission frame carries the
// spawn's args (`Session.ts:7687`), so the row is now born from the gate itself
// — named, typed, and open BEFORE the child's first frame. It had to be: a
// child's PLAN is untagged even at 0.21.1, so with no window open it was
// forwarded as the user's own plan. Adoption stays the recovery path for a
// rootless child (specs f-4 / f-13), which is what it always was on every other
// wire. What this spec pins now is that the gated wire produces ONE complete
// row, whichever path opened it.
const gatedSpawnScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      // No emitToolCall for the agent: THAT is the finding.
      .emitAgentSpawnGated({
        callId: AGENT_A,
        description: "Review the diff",
        subagentType: ROLE_A,
        runInBackground: false,
      })
      .sleep(50)
      // The child runs; its frames are the first thing that names the agent.
      .emitText("A is reviewing the diff without ever having a spawn frame", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("R-4 · a permission-gated spawn still produces a complete agent row", () =>
  Effect.gen(function* () {
    const events = yield* run(
      gatedSpawnScript,
      "qwen-audit-gated-spawn",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
      { approveRequests: true },
    );

    // The row exists and completes, born entirely from adoption.
    assert.deepStrictEqual(
      lifecycleOf(events, AGENT_A),
      ["task.started", "task.completed"],
      "a permission-gated spawn produced no agent row at all",
    );
    // The child's narration is on the row, not in the chat.
    assert.include(progressFor(events, AGENT_A).join(" "), "without ever having a spawn frame");
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL, "a rootless child's narration leaked into the chat");
    // The permission request still surfaced — the gate is what a user answers.
    assert.isAtLeast(events.filter((e) => e.type === "request.opened").length, 1);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(gatedSpawnScript), testServices)),
    TestClock.withLive,
  ),
);

// R-4b — the latch invariant, RESTATED. "provenance arrives with the spawn
// frame" is only true when a spawn frame exists. The property that actually
// holds in BOTH modes is stronger and is what the segment guard depends on:
//
//   a window can never be open while the latch is unset.
//
//   · gated mode  — the window is opened either by adoption (only a TAGGED
//     frame can adopt, and that same frame sets the latch) or, since FIX ROUND
//     3, by the spawn's permission frame — which sets the latch in the same
//     operation, on its own proof: v0.13.1 sent no `_meta` on a top-level
//     permission request at all (v0.13.1 Session.ts:782-793 vs :7692-7695);
//   · auto-edit   — the spawn `tool_call` carries `provenance`, so the latch is
//     set at the moment the window opens.
//
// Pinned by an untagged notice arriving BEFORE the child speaks — the exact
// f-1 scenario — on the gated wire, where no spawn frame ever set the latch.
const gatedSpawnWithEarlyNotice: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitAgentSpawnGated({
        callId: AGENT_A,
        description: "Review the diff",
        subagentType: ROLE_A,
        runInBackground: false,
      })
      .sleep(50)
      // Untagged, non-empty, BEFORE any child frame — no window is open yet.
      .emitText("✗ **PreToolUse blocked**: write_file denied by hook")
      .emitText("A speaks at last", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("R-4b · on the gated wire an untagged notice is still the parent's, with an itemId", () =>
  Effect.gen(function* () {
    const events = yield* run(
      gatedSpawnWithEarlyNotice,
      "qwen-audit-gated-notice",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
      { approveRequests: true },
    );
    assert.notInclude(
      progressFor(events, AGENT_A).join(" "),
      "PreToolUse blocked",
      "a parent notice was rendered as the agent's narration on the gated wire",
    );
    const notice = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .find((e) => e.payload.delta.includes("PreToolUse blocked"));
    assert.isDefined(notice, "the parent's notice never reached the chat");
    assert.isDefined(notice!.itemId, "the parent's notice reached the chat with no itemId");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(gatedSpawnWithEarlyNotice), testServices),
    ),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// R-2 — the TEARDOWN-path settled-id write. Reachable and load-bearing: both
// teardown call sites drain BEFORE the notification fiber is interrupted (by
// their own comments), so queued frames are still processed in that window —
// and "Stop while a child is mid-sentence" is the likeliest straggler there is.
const teardownStragglerScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitText("A is mid-sentence when the CLI dies", META_A)
      .sleep(50)
      .exit(137),
};

it.effect("R-2 · a straggler for a TEARDOWN-drained agent does not re-open it", () =>
  Effect.gen(function* () {
    const events = yield* run(
      teardownStragglerScript,
      "qwen-audit-teardown-tombstone",
      (e) => e.type === "session.exited",
    );
    // The drain settled it exactly once; nothing may re-open it afterwards.
    assert.deepStrictEqual(
      lifecycleOf(events, AGENT_A),
      ["task.started", "task.completed"],
      "the teardown-drained agent was re-opened or settled twice",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(teardownStragglerScript), testServices)),
    TestClock.withLive,
  ),
);

// R-3 — the EVICTION-path settled-id write. The f-12 spec drives eviction but
// asserts only the terminal; this asserts the evicted id became a TOMBSTONE, so
// a later tagged frame for it cannot resurrect the row the cap just closed.
const evictThenStragglerScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) => {
    let chain = steps;
    for (let index = 0; index < QWEN_MAX_OPEN_AGENT_WINDOWS + 1; index += 1) {
      chain = chain.emitToolCall(agentRoot(`call-agent-${index}`, `Task ${index}`, ROLE_A));
    }
    chain
      // agent-0 was evicted by the 11th spawn; its straggler must be dropped.
      .emitText("evicted agent still talking", {
        parentToolCallId: "call-agent-0",
        subagentType: ROLE_A,
      })
      .emitText(SENTINEL)
      .respondOk();
  },
};

it.effect("R-3 · an evicted agent's id is a tombstone — its straggler cannot resurrect it", () =>
  Effect.gen(function* () {
    const events = yield* run(
      evictThenStragglerScript,
      "qwen-audit-evict-tombstone",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    assert.deepStrictEqual(
      lifecycleOf(events, "call-agent-0"),
      ["task.started", "task.completed"],
      "the evicted agent was re-opened by a later tagged frame",
    );
    const transcript = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .map((e) => e.payload.delta)
      .join("");
    assert.strictEqual(transcript, SENTINEL, "the evicted agent's straggler leaked into the chat");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(evictThenStragglerScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// R-6 — the tombstone set is BOUNDED. Drive more settles than the bound, then
// prove the oldest id was retired (its straggler is treated as a fresh agent
// again) while a recent one is still remembered. Asserting the retirement is
// what makes this a bound and not a leak: a spec that only checked the recent id
// would pass on an unbounded set too.
const overflowSettlesScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) => {
    let chain = steps;
    for (let index = 0; index < QWEN_MAX_SETTLED_AGENT_IDS + 2; index += 1) {
      const id = `call-settled-${index}`;
      chain = chain
        .emitToolCall(agentRoot(id, `Task ${index}`, ROLE_A))
        .emitToolCallUpdate(agentSettle(id, ROLE_A, `Task ${index}`));
    }
    chain
      .emitText("straggler for the OLDEST, long-retired tombstone", {
        parentToolCallId: "call-settled-0",
        subagentType: ROLE_A,
      })
      .emitText("straggler for a RECENT tombstone", {
        parentToolCallId: `call-settled-${QWEN_MAX_SETTLED_AGENT_IDS + 1}`,
        subagentType: ROLE_A,
      })
      .emitText(SENTINEL)
      .respondOk();
  },
};

it.effect("R-6 · the settled-id memory is bounded: the oldest tombstone is retired", () =>
  Effect.gen(function* () {
    const events = yield* run(
      overflowSettlesScript,
      "qwen-audit-tombstone-bound",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    // The RECENT tombstone still protects its row: no re-open.
    assert.deepStrictEqual(
      lifecycleOf(events, `call-settled-${QWEN_MAX_SETTLED_AGENT_IDS + 1}`),
      ["task.started", "task.completed"],
      "a recent tombstone was forgotten — the bound is too small to cover a straggler",
    );
    // The OLDEST was retired, so its straggler is adopted as a new run. That is
    // the intended trade: bounded memory over perfect recall, and it is only
    // reachable after 100 completed agents in one session.
    assert.deepStrictEqual(
      lifecycleOf(events, "call-settled-0"),
      ["task.started", "task.completed", "task.started"],
      "the oldest tombstone was still remembered — the set is not bounded",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(overflowSettlesScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// R2.3 TRIPWIRE — the §3a acceptance (no v2 builders for the six untagged
// Session.ts message sites) rests on an unstated invariant: our reader looks at
// exactly `_meta.parentToolCallId` and `_meta.provenance` and ignores every
// other key. Two of those six carry `_meta.source` + `qwenDiscreteMessage`, one
// carries `{...turnMeta, rewritten, turnIndex}`. This states the invariant.
const decoratedUntaggedScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitText("A is working", META_A)
      // Untagged, but decorated with every non-attribution key the six sites use.
      .emitText("a background notification, decorated", {
        source: "background_notification",
        qwenDiscreteMessage: true,
        rewritten: true,
        turnIndex: 3,
      } as never)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("R2.3 · non-attribution _meta keys are ignored — a decorated chunk is a bare one", () =>
  Effect.gen(function* () {
    const events = yield* run(
      decoratedUntaggedScript,
      "qwen-audit-meta-ignored",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    // Treated exactly as an untagged parent chunk: chat, with an itemId, and not
    // on the agent's row — `source`/`rewritten`/`qwenDiscreteMessage` change
    // nothing.
    assert.notInclude(progressFor(events, AGENT_A).join(" "), "decorated");
    const decorated = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .find((e) => e.payload.delta.includes("decorated"));
    assert.isDefined(decorated, "a decorated untagged chunk was swallowed");
    assert.isDefined(decorated!.itemId, "a decorated untagged chunk lost its itemId");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(decoratedUntaggedScript), testServices)),
    TestClock.withLive,
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// OPEN-2 — the two latch copies. They are NOT equal in general (the adapter
// latches on a tagged text chunk too; the runtime does not), so the invariant
// that actually makes the divergence safe is the one worth asserting:
//
//   the runtime's half-gated branch (`!v2Wire && openAgents.size > 0`) can only
//   fire on a genuine v0.13.1 wire — because a non-empty `openAgents` implies a
//   root tool_call frame was seen, which implies provenance was seen.
//
// Observable consequence: on a v2 wire, a chunk arriving while a root window is
// open is never treated as a child's merely because a window exists. Proven from
// outside via the itemId, which is exactly what the guard controls.
const v2WindowOpenUntagged: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitText("parent text while a root window is open")
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("OPEN-2 · with a root window open on a v2 wire, untagged text keeps its itemId", () =>
  Effect.gen(function* () {
    const events = yield* run(
      v2WindowOpenUntagged,
      "qwen-audit-latch-equality",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
    );
    const parent = events
      .filter((e): e is ContentDelta => e.type === "content.delta")
      .find((e) => e.payload.delta.includes("parent text while"));
    assert.isDefined(parent, "the parent's text never reached the chat");
    assert.isDefined(
      parent!.itemId,
      "the runtime treated a v2 untagged chunk as a child's because a window was open",
    );
    assert.notInclude(progressFor(events, AGENT_A).join(" "), "parent text while");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(v2WindowOpenUntagged), testServices)),
    TestClock.withLive,
  ),
);

// ═════════════════════════════════════════════════════════════════════════════
// ROUND 3 — R3-1: on the gated wire, adoption must also run on the TOOL path.
//
// Round 2 modelled the permission-gated wire, where the window is born only by
// adoption — but adoption ran on the text and thought paths only. A child that
// tool-called before it narrated therefore emitted `tool.progress` for a task
// the fold had never seen open, and the fold bails on an unknown taskId
// (subagentRuntime's `const agent = agents.get(taskId); if (!agent) break;`), so
// the heartbeats were dropped. A child that never narrated at all had no
// `task.started` whatsoever and materialised already-Completed from the settle's
// getOrCreate — it never showed as running.
//
// Both sequences below are Seat B's measured probes, turned into specs.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ru-code (agentic-flow wave, FIX ROUND 3): the DEFAULT-MODE spawn, whose every
 * byte is pinned on `qwenAgentSpawnPermissionRequest` (Session.ts:7677-7697).
 * The hand-rolled payload this replaced carried no `title` and options qwen
 * never offers — a wire the engine cannot send.
 */
const gatedSpawn = (callId: string) => ({
  callId,
  description: "Review the diff",
  subagentType: ROLE_A,
  runInBackground: false,
});

const innerCall = (callId: string, toolName: string, meta: typeof META_A) => ({
  toolCallId: callId,
  toolName,
  title: `${toolName}: /a.ts`,
  status: "pending" as const,
  kind: "read" as const,
  rawInput: { absolute_path: "/a.ts" },
  subagentMeta: meta,
});

/** The order of the two lifecycle/heartbeat kinds for one task, as observed. */
const rowOrderFor = (events: ReadonlyArray<ProviderRuntimeEvent>, taskId: string) =>
  events
    .filter(
      (e) =>
        (e.type === "task.started" || e.type === "task.completed" || e.type === "tool.progress") &&
        (e as { payload: { taskId?: string } }).payload.taskId === taskId,
    )
    .map((e) => e.type);

// R3-1a — the common opening move: the child reads a file, THEN narrates.
const gatedToolFirstScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitAgentSpawnGated(gatedSpawn(AGENT_A))
      .sleep(50)
      .emitToolCall(innerCall(INNER_A, "read_file", META_A))
      .emitToolCallUpdate({
        toolCallId: INNER_A,
        toolName: "read_file",
        status: "completed",
        text: "42 lines",
        subagentMeta: META_A,
      })
      .emitText("A speaks only after reading", META_A)
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect("R3-1a · a gated child that tool-calls before speaking opens its row FIRST", () =>
  Effect.gen(function* () {
    const events = yield* run(
      gatedToolFirstScript,
      "qwen-audit-gated-tool-first",
      (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
      { approveRequests: true },
    );

    const order = rowOrderFor(events, AGENT_A);
    assert.strictEqual(
      order[0],
      "task.started",
      `heartbeats preceded the row's birth and would be dropped by the fold: ${order.join(",")}`,
    );
    assert.isAtLeast(
      order.filter((type) => type === "tool.progress").length,
      1,
      "the child's tool activity never reached the row",
    );
    // Exactly one birth: the later narration must not adopt a second time.
    assert.lengthOf(
      order.filter((type) => type === "task.started"),
      1,
      "the row was opened more than once",
    );
    assert.deepStrictEqual(lifecycleOf(events, AGENT_A), ["task.started", "task.completed"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(gatedToolFirstScript), testServices)),
    TestClock.withLive,
  ),
);

// R3-1b — the child that NEVER narrates. Before the fix this produced no
// `task.started` at all: `firstStarted = -1` in Seat B's probe.
const gatedToolOnlyScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitAgentSpawnGated(gatedSpawn(AGENT_A))
      .sleep(50)
      .emitToolCall(innerCall(INNER_A, "read_file", META_A))
      .emitToolCallUpdate({
        toolCallId: INNER_A,
        toolName: "read_file",
        status: "completed",
        text: "42 lines",
        subagentMeta: META_A,
      })
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect(
  "R3-1b · a gated child that only uses tools still shows as RUNNING before it settles",
  () =>
    Effect.gen(function* () {
      const events = yield* run(
        gatedToolOnlyScript,
        "qwen-audit-gated-tool-only",
        (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
        { approveRequests: true },
      );

      const order = rowOrderFor(events, AGENT_A);
      assert.strictEqual(
        order[0],
        "task.started",
        `a tool-only child materialised already-Completed: ${order.join(",")}`,
      );
      assert.isBelow(
        order.indexOf("task.started"),
        order.indexOf("task.completed"),
        "the row was never live — it appeared only at the settle",
      );
      assert.deepStrictEqual(lifecycleOf(events, AGENT_A), ["task.started", "task.completed"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(gatedToolOnlyScript), testServices)),
      TestClock.withLive,
    ),
);

// R3-1c — NON-REGRESSION on the auto-approved wire. There the spawn `tool_call`
// opens the window before any child frame, so tool-path adoption is unreachable
// by construction (`readQwenOrphanAgent` returns undefined for an open window).
// Cheap to pin, and it is the reason the fix could be made unconditionally
// rather than waiting on the owner smoke.
const autoApprovedToolFirstScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitToolCall(agentRoot(AGENT_A, "Review the diff", ROLE_A))
      .emitToolCall(innerCall(INNER_A, "read_file", META_A))
      .emitToolCallUpdate(agentSettle(AGENT_A, ROLE_A, "Review the diff"))
      .emitText(SENTINEL)
      .respondOk(),
};

it.effect(
  "R3-1c · on the auto-approved wire the spawn frame still opens the row, exactly once",
  () =>
    Effect.gen(function* () {
      const events = yield* run(
        autoApprovedToolFirstScript,
        "qwen-audit-auto-tool-first",
        (e) => e.type === "content.delta" && e.payload.delta === SENTINEL,
      );
      const order = rowOrderFor(events, AGENT_A);
      assert.strictEqual(order[0], "task.started");
      assert.lengthOf(
        order.filter((type) => type === "task.started"),
        1,
        "tool-path adoption double-opened a row the spawn frame had already opened",
      );
      // And the row keeps the spawn's DESCRIPTION, not the adoption fallback title
      // (adoption can only title from `subagent_type`).
      const started = events.find(
        (e) =>
          e.type === "task.started" &&
          (e as { payload: { taskId?: string } }).payload.taskId === AGENT_A,
      );
      assert.strictEqual(
        (started as { payload: { title?: string } }).payload.title,
        "Review the diff",
        "the spawn's description was lost — adoption overwrote a properly-titled row",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(fakeAcpSpawnerLayer(autoApprovedToolFirstScript), testServices),
      ),
      TestClock.withLive,
    ),
);
