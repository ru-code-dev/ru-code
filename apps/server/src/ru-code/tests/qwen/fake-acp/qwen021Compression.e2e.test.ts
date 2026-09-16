// @effect-diagnostics preferSchemaOverJson:off -- every JSON.stringify below builds
// a HUMAN-READABLE assertion-failure message (the observed event list, the observed
// bubble text). Nothing is transported or decoded, so a Schema codec would add a
// declaration per shape and make the evidence harder to read, not safer.
// ru-code (qwen-compression wave): THE 0.21.1 COMPRESSION WIRE, end to end
// against the REAL QwenAdapter.
//
// THE CHANNEL THESE SPECS PIN. At 0.13.1 the CLI reported a slash command's
// output as a VENDOR EXTENSION NOTIFICATION (`_qwencode/slash_command` with
// `{message, messageType}`). That method no longer exists in the CLI at 0.21.1:
// `Session.ts` emits exactly ONE `extNotification` in the entire file —
// `_qwencode/end_turn` (Session.ts:6078) — and `_qwencode/slash_command`
// survives only as a legacy INBOUND handler in the VS Code companion
// (vscode-ide-companion/src/services/acpConnection.ts:379). Slash-command output
// moved onto an ordinary `session/update` `agent_message_chunk` stamped
// `_meta.source:"slash_command"` (MessageEmitter.ts:152-165), and qwen's own
// comment says why (Session.ts:8446-8448): "extNotification only goes to the ACP
// debug log and is not rendered by Zed." qwen's OWN auto-compaction, new in ACP
// mode since v0.15.7, rides a BARE `agent_message_chunk` with no `_meta` at all
// (Session.ts:4436-4440 → :4668-4673).
//
// Every case here FAILED before the ingress moved onto those two channels (the
// ring never snapped to the post-compaction size, the raw English leaked into
// the bubble, and `compactContext` closed its row with «Провайдер не подтвердил
// сжатие контекста»). They are the wave's acceptance criteria and its regression
// guard.
//
// Every case settles on the LIVE clock for `SETTLE` and then asserts on the
// collected events, so a break reads as "expected 1, observed 0" rather than as
// a wait that timed out and died.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { resolveString } from "@ru-code/localization";
import { CONTEXT_WINDOW_TOKENS } from "@ru-code/qwen/constants";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { EventNdjsonLogger } from "../../../../provider/Layers/EventNdjsonLogger.ts";
import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { qwenAutoCompressionDiagnostic, qwenCompressResultMessage } from "./qwen021Frames.ts";
import { collectAdapterEvents } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const enText = (value: unknown): string => resolveString(String(value), "en");

/** Live-clock quiet window: long enough for every forked adapter fiber to land. */
const SETTLE = "1200 millis";

const PRE_TOKENS = 190_000;
const POST_TOKENS = 12_345;
// Deliberately DIFFERENT from POST_TOKENS so a meter update carrying POST_TOKENS
// can only have come from the compaction notice itself, never from the turn's
// own usage frame.
const POST_TURN_USAGE_TOKENS = 13_001;
const AUTO_MODEL = "qwen3-coder-plus";

const testServices = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

type TokenUsageEvent = Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;
type ContentDeltaEvent = Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;

const tokenUsage = (events: ReadonlyArray<ProviderRuntimeEvent>): TokenUsageEvent[] =>
  events.filter((e): e is TokenUsageEvent => e.type === "thread.token-usage.updated");

const deltas = (events: ReadonlyArray<ProviderRuntimeEvent>): ContentDeltaEvent[] =>
  events.filter((e): e is ContentDeltaEvent => e.type === "content.delta");

const deltaText = (events: ReadonlyArray<ProviderRuntimeEvent>): string =>
  deltas(events)
    .map((e) => enText(e.payload.delta))
    .join("");

const compactionCompleted = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
): TaskCompletedEvent | undefined =>
  events.find(
    (e): e is TaskCompletedEvent =>
      e.type === "task.completed" && e.payload.taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX),
  );

// ── Case 1+2: MANUAL /compress typed by the user, 0.21.1 wire ───────────────
// The fake speaks the real channel: two `agent_message_chunk`s with
// `_meta.source:"slash_command"`, then `stopReason:"end_turn"` — exactly what
// Session.ts:2786-2797 does once `#processSlashCommandResult` returns null.

const MANUAL_THREAD = ThreadId.make("qwen021-compress-manual");

const manualScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitCompressProgress()
      .emitCompressResult({
        preTokens: PRE_TOKENS,
        postTokens: POST_TOKENS,
      })
      .respondOk("end_turn"),
};

it.effect("0.21.1 manual /compress: the context ring snaps to the post-compaction size", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: MANUAL_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: MANUAL_THREAD, input: "/compress" });
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    const meterUpdates = tokenUsage(collector.events);
    const snapped = meterUpdates.filter((e) => e.payload.usage.usedTokens === POST_TOKENS);
    assert.isAtLeast(
      snapped.length,
      1,
      `THE BREAK: after a 0.21.1 /compress the adapter emitted NO thread.token-usage.updated ` +
        `carrying the post-compaction size ${String(POST_TOKENS)}. ` +
        `Observed token-usage events: ${JSON.stringify(
          meterUpdates.map((e) => e.payload.usage),
        )}. The compress result arrived as an agent_message_chunk with ` +
        `_meta.source="slash_command" (MessageEmitter.ts:152-165), and ` +
        `QwenAdapter.ts:2749 only reads methods ending in "/slash_command".`,
    );
    assert.strictEqual(snapped[0]!.payload.usage.maxTokens, CONTEXT_WINDOW_TOKENS);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(manualScript),
        testServices("ru-code-q21-compress-manual-"),
      ),
    ),
    TestClock.withLive,
  ),
);

const MANUAL_BUBBLE_THREAD = ThreadId.make("qwen021-compress-manual-bubble");

it.effect(
  "0.21.1 manual /compress: the bubble is the localized compaction line, not raw English",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: MANUAL_BUBBLE_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: MANUAL_BUBBLE_THREAD, input: "/compress" });
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      const text = deltaText(collector.events);
      assert.include(
        text,
        `Compaction succeeded (${String(PRE_TOKENS)} -> ${String(POST_TOKENS)})`,
        `THE BREAK: the localized compaction line is absent. Observed bubble text: ` +
          `${JSON.stringify(text)}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(manualScript),
          testServices("ru-code-q21-compress-bubble-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const MANUAL_LEAK_THREAD = ThreadId.make("qwen021-compress-manual-leak");

it.effect("0.21.1 manual /compress: qwen's raw English result never reaches the chat", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: MANUAL_LEAK_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: MANUAL_LEAK_THREAD, input: "/compress" });
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    const text = deltaText(collector.events);
    assert.notInclude(
      text,
      qwenCompressResultMessage(PRE_TOKENS, POST_TOKENS),
      `THE BREAK: qwen's raw, non-localized English result leaked verbatim into the ` +
        `chat bubble. Observed bubble text: ${JSON.stringify(text)}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(manualScript),
        testServices("ru-code-q21-compress-leak-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Case 3: HIDDEN compaction (the meter button / auto-compact), 0.21.1 wire ─
// `compactContext` sends the hidden "/compress" and reads the outcome out of
// `ctx.hiddenCompressOutcome`, which ONLY the ext-notification handler writes
// (QwenAdapter.ts:2770-2782). On the 0.21.1 wire it stays undefined, so
// QwenAdapter.ts:5276-5282 closes the row as FAILED with the
// "provider did not confirm" text — the «Провайдер не подтвердил сжатие
// контекста» the field report names.

const HIDDEN_THREAD = ThreadId.make("qwen021-compress-hidden");
const hiddenPromptTexts: string[] = [];

const hiddenScript: FakeAcpScript = {
  dialect: "v2",
  onPromptText: (text) => hiddenPromptTexts.push(text),
  onPrompt: (steps) =>
    steps
      .emitCompressProgress()
      .emitCompressResult({
        preTokens: PRE_TOKENS,
        postTokens: POST_TOKENS,
      })
      .respondOk("end_turn"),
};

it.effect(
  "0.21.1 hidden compaction: the row completes, and «provider did not confirm» is never shown",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: HIDDEN_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.compactContext!(HIDDEN_THREAD);
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      // The hidden prompt did go out — the fake saw the literal "/compress".
      assert.include(hiddenPromptTexts, "/compress");

      const completed = compactionCompleted(collector.events);
      assert.isDefined(completed, "no compaction task.completed row at all");
      const summary = enText(completed!.payload.summary);
      assert.notInclude(
        summary,
        "did not confirm",
        `THE BREAK: the compaction row failed with the "provider did not confirm" text ` +
          `(«Провайдер не подтвердил сжатие контекста») even though qwen 0.21.1 DID compress ` +
          `and reported it on its real channel. Observed status=${String(
            completed!.payload.status,
          )} summary=${JSON.stringify(summary)}`,
      );
      assert.strictEqual(
        completed!.payload.status,
        "completed",
        `THE BREAK: expected a completed compaction row, observed status=${String(
          completed!.payload.status,
        )} summary=${JSON.stringify(summary)}`,
      );
      assert.deepStrictEqual(completed!.payload.usage, {
        preTokens: PRE_TOKENS,
        postTokens: POST_TOKENS,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(hiddenScript),
          testServices("ru-code-q21-compress-hidden-"),
        ),
      ),
      TestClock.withLive,
    ),
);

// ── Case 3b: the confirmation is CONSUMED LATE ──────────────────────────────
// THE ORDERING HAZARD the barrier exists for, reproduced deterministically.
//
// qwen awaits its confirmation chunk before answering the prompt
// (Session.ts:8477-8480 → MessageEmitter.ts:152-165 → :4247-4254) and both ride
// ONE ordered stdio pipe, so the chunk is always OFFERED into the runtime's FIFO
// event queue before `session/prompt` resolves. It is NOT guaranteed to have
// been CONSUMED: the notification fiber is a different fiber from the one
// awaiting the prompt. At 0.13.1 the gap did not exist, because the ext handler
// ran inline in transport dispatch.
//
// Forcing the gap needs the consumer to be SLOW, and in production it is: the
// notification loop's first act for every frame is `logNative`, an NDJSON write
// to disk (QwenAdapter.ts, `case "ContentDelta"`). A native logger whose write
// takes LATE_WRITE_DELAY reproduces exactly that cost, so with a backlog of
// LATE_BACKLOG_FRAMES ahead of it the confirmation is provably still in the
// queue when the prompt resolves. Without the barrier the row closes "The
// provider sent no compaction confirmation."; with it the outcome is final
// before it is read — and no timer is involved either way.
const LATE_THREAD = ThreadId.make("qwen021-compress-late-consumption");
const LATE_BACKLOG_FRAMES = 40;
const LATE_WRITE_DELAY = "25 millis";
/** The backlog's own lag (~1s) plus room for the row to close after it. */
const LATE_SETTLE = "6 seconds";

/** A native event logger whose every write costs real time — see above. */
const slowNativeLogger: EventNdjsonLogger = {
  filePath: "/dev/null",
  write: () => Effect.sleep(LATE_WRITE_DELAY),
  close: () => Effect.void,
};

const lateScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) => {
    // Thought frames: they reach the notification loop (and so the slow write)
    // but render nothing, so the backlog cannot affect any assertion.
    for (let index = 0; index < LATE_BACKLOG_FRAMES; index += 1) {
      steps.emitThought(`шаг ${String(index)}`);
    }
    steps
      .emitCompressProgress()
      .emitCompressResult({ preTokens: PRE_TOKENS, postTokens: POST_TOKENS })
      .respondOk("end_turn");
  },
};

it.effect("0.21.1 hidden compaction: the confirmation counts even when it is consumed LATE", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      nativeEventLogger: slowNativeLogger,
    });
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: LATE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.compactContext!(LATE_THREAD);
    yield* Effect.sleep(LATE_SETTLE);
    yield* collector.stop;

    const completed = compactionCompleted(collector.events);
    assert.isDefined(completed, "no compaction task.completed row at all");
    assert.strictEqual(
      completed!.payload.status,
      "completed",
      `THE BREAK: the compaction row did not see its confirmation — the chunk was ` +
        `still in the event queue when compactContext read the outcome. Observed ` +
        `status=${String(completed!.payload.status)} ` +
        `summary=${JSON.stringify(enText(completed!.payload.summary))}`,
    );
    assert.deepStrictEqual(completed!.payload.usage, {
      preTokens: PRE_TOKENS,
      postTokens: POST_TOKENS,
    });
    assert.isAtLeast(
      tokenUsage(collector.events).filter((e) => e.payload.usage.usedTokens === POST_TOKENS).length,
      1,
      "the ring must still take the post-compaction size",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(lateScript),
        testServices("ru-code-q21-compress-late-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Case 3c: an INFLATED result is still a confirmation ─────────────────────
// qwen reports a compaction that GREW the context as an ordinary success line —
// `doCompress` returns a `ChatCompressionInfo` on every path, so
// `COMPRESSION_FAILED_INFLATED_TOKEN_COUNT` (turn.ts:311) never reaches the wire
// and `if (!compressed)` at compressCommand.ts:101 is unreachable
// (WORKFLOW/02 §2.2 "Trap"). So the parser must apply NO size check, and the
// numbers must be judged downstream: this pair loses ground, which is the
// low-gain branch, and the row still carries the raw numbers so the circuit
// breaker can re-derive its state from persisted history after a restart.
const INFLATED_THREAD = ThreadId.make("qwen021-compress-inflated");
const INFLATED_PRE = 15_762;
const INFLATED_POST = 16_246;

const inflatedScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitCompressProgress()
      .emitCompressResult({ preTokens: INFLATED_PRE, postTokens: INFLATED_POST })
      .respondOk("end_turn"),
};

it.effect("0.21.1 hidden compaction: an INFLATED result warns, and still moves the ring", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: INFLATED_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.compactContext!(INFLATED_THREAD);
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    const completed = compactionCompleted(collector.events);
    assert.isDefined(completed, "no compaction task.completed row at all");
    // A confirmation, not a failure — the row is `completed`, toned `warning`.
    assert.strictEqual(
      completed!.payload.status,
      "completed",
      `THE BREAK: an inflated result was treated as an unconfirmed compaction. ` +
        `summary=${JSON.stringify(enText(completed!.payload.summary))}`,
    );
    assert.strictEqual(completed!.payload.tone, "warning");
    assert.include(
      enText(completed!.payload.summary),
      `Compaction did not reduce the context (${String(INFLATED_PRE)} -> ${String(INFLATED_POST)})`,
    );
    // The raw numbers ride the row: they ARE the persisted breaker state.
    assert.deepStrictEqual(completed!.payload.usage, {
      preTokens: INFLATED_PRE,
      postTokens: INFLATED_POST,
    });
    // And the ring takes the post value even though it grew — that IS the
    // thread's context size now.
    assert.isAtLeast(
      tokenUsage(collector.events).filter((e) => e.payload.usage.usedTokens === INFLATED_POST)
        .length,
      1,
      `the ring must take the inflated post size. Observed: ${JSON.stringify(
        tokenUsage(collector.events).map((e) => e.payload.usage),
      )}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(inflatedScript),
        testServices("ru-code-q21-compress-inflated-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Case 4: AUTO-compaction inside a normal turn, 0.21.1 wire ───────────────
// qwen compresses BEFORE the model send (Session.ts:4364-4392), emits the notice
// as a BARE `agent_message_chunk` (Session.ts:4436-4440 → :4668-4673), then
// streams the answer and finally the usage frame carrying the POST-compaction
// prompt tokens. So the turn's frame order is: notice → text → usage → end_turn.

const AUTO_THREAD = ThreadId.make("qwen021-compress-auto");

const autoScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      .emitAutoCompaction({
        model: AUTO_MODEL,
        preTokens: PRE_TOKENS,
        postTokens: POST_TOKENS,
      })
      .emitText("Готово.")
      .emitUsageChunk(POST_TURN_USAGE_TOKENS)
      .respondOk("end_turn"),
};

it.effect(
  "0.21.1 auto-compaction mid-turn: the ring snaps to the post-compaction size at the notice",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: AUTO_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: AUTO_THREAD, input: "продолжай" });
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      const meterUpdates = tokenUsage(collector.events);
      const snapped = meterUpdates.filter((e) => e.payload.usage.usedTokens === POST_TOKENS);
      assert.isAtLeast(
        snapped.length,
        1,
        `THE BREAK: qwen auto-compacted mid-turn (${String(PRE_TOKENS)} -> ${String(
          POST_TOKENS,
        )}) and the adapter emitted NO thread.token-usage.updated carrying ${String(
          POST_TOKENS,
        )}. Observed token-usage events: ${JSON.stringify(
          meterUpdates.map((e) => e.payload.usage),
        )}. The notice is a bare agent_message_chunk with no _meta at all ` +
          `(Session.ts:4668-4673), so nothing in the adapter reads it.`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(autoScript),
          testServices("ru-code-q21-compress-auto-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const AUTO_LEAK_THREAD = ThreadId.make("qwen021-compress-auto-leak");

it.effect(
  "0.21.1 auto-compaction mid-turn: the raw English diagnostic never reaches the chat",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: AUTO_LEAK_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: AUTO_LEAK_THREAD, input: "продолжай" });
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      const text = deltaText(collector.events);
      assert.notInclude(
        text,
        qwenAutoCompressionDiagnostic({
          model: AUTO_MODEL,
          originalTokenCount: PRE_TOKENS,
          newTokenCount: POST_TOKENS,
        }),
        `THE BREAK: qwen's raw English auto-compaction diagnostic leaked verbatim into the ` +
          `chat bubble. Observed bubble text: ${JSON.stringify(text)}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(autoScript),
          testServices("ru-code-q21-compress-auto-leak-"),
        ),
      ),
      TestClock.withLive,
    ),
);

// ── Case 4c: the notice on a CONTINUATION send ──────────────────────────────
// THE POSITION THE FIRST GATE MISSED.
//
// qwen runs its compaction check before EVERY model send of a turn, not just the
// first: the turn loop calls `#sendMessageStreamWithAutoCompression` again for
// each tool-result continuation (Session.ts:3602 → :3655, and :2970, :5319,
// :5829), and the notice is emitted from whichever send compacted (:4437-4441).
// So the ordinary agentic shape puts it AFTER the turn has already spoken:
//
//     text → tool call → tool result → [compaction notice] → text
//
// A gate keyed on "the turn's opening agent message" drops exactly that, and a
// dropped notice means qwen's raw English rendered as assistant prose with NO
// compaction row and NO ring write — WORKFLOW/04 §A.1 S5/S6, the symptom this
// wave exists to remove. The emitter's invariant head is what admits it here.
const CONTINUATION_THREAD = ThreadId.make("qwen021-compress-continuation");
const CONTINUATION_TOOL_CALL_ID = "call-read-1";

const continuationScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      // The turn speaks FIRST — after this, `sawTurnAgentOutput` is set and the
      // opening-message admission can no longer apply.
      .emitText("Смотрю файлы…")
      .emitToolCall({
        toolCallId: CONTINUATION_TOOL_CALL_ID,
        toolName: "read_file",
        title: "read_file: /a.ts",
        status: "pending",
        kind: "read",
        rawInput: { absolute_path: "/a.ts" },
      })
      .emitToolCallUpdate({
        toolCallId: CONTINUATION_TOOL_CALL_ID,
        toolName: "read_file",
        status: "completed",
        text: "export const a = 1;",
      })
      // The CONTINUATION send compacts.
      .emitAutoCompaction({
        model: AUTO_MODEL,
        preTokens: PRE_TOKENS,
        postTokens: POST_TOKENS,
      })
      .emitText("Готово.")
      .emitUsageChunk(POST_TURN_USAGE_TOKENS)
      .respondOk("end_turn"),
};

it.effect("0.21.1 auto-compaction on a CONTINUATION send: row, ring, and no leak", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: CONTINUATION_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: CONTINUATION_THREAD, input: "почини это" });
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    const completed = compactionCompleted(collector.events);
    assert.isDefined(
      completed,
      `THE BREAK: qwen compacted on a tool-result continuation and the timeline got NO ` +
        `compaction row. Observed bubble text: ${JSON.stringify(deltaText(collector.events))}`,
    );
    assert.strictEqual(completed!.payload.status, "completed");
    assert.deepStrictEqual(completed!.payload.usage, {
      preTokens: PRE_TOKENS,
      postTokens: POST_TOKENS,
    });
    // The ring takes the post-compaction size — distinct from the turn's own
    // closing usage frame, so this value can only have come from the notice.
    assert.isAtLeast(
      tokenUsage(collector.events).filter((e) => e.payload.usage.usedTokens === POST_TOKENS).length,
      1,
      `THE BREAK: no ring write carried ${String(POST_TOKENS)}. Observed: ${JSON.stringify(
        tokenUsage(collector.events).map((e) => e.payload.usage),
      )}`,
    );
    // And the raw English never reached the chat, while the turn's own words did.
    const text = deltaText(collector.events);
    assert.notInclude(
      text,
      qwenAutoCompressionDiagnostic({
        model: AUTO_MODEL,
        originalTokenCount: PRE_TOKENS,
        newTokenCount: POST_TOKENS,
      }),
      `THE BREAK: qwen's raw English leaked. Observed bubble text: ${JSON.stringify(text)}`,
    );
    assert.include(text, "Смотрю файлы…");
    assert.include(text, "Готово.");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(continuationScript),
        testServices("ru-code-q21-compress-continuation-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Case 4d: THE FALSE POSITIVE ─────────────────────────────────────────────
// The other half of the gate, and the whole safety argument for a LOOSE parser.
//
// `parseQwenCompactionText` deliberately reads "I compressed 200 files into 3
// archives." as a result — one rule for every shape, no per-version strings
// (pinned by `compactionWire.test.ts` "still parses model prose that mentions
// compressing"). What must stop it being acted on is the GATE: mid-turn, a bare
// chunk carrying neither of qwen's invariant heads is the MODEL talking, so it
// belongs in the bubble verbatim and must mint no row and move no ring.
const FALSE_POSITIVE_THREAD = ThreadId.make("qwen021-compress-false-positive");
const MODEL_PROSE = "I compressed 200 files into 3 archives.";

const falsePositiveScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps
      // The turn speaks first, so the opening-message admission cannot apply …
      .emitText("Начинаю. ")
      // … and this chunk carries no head, so neither can the head admission.
      .emitText(MODEL_PROSE)
      .emitUsageChunk(POST_TURN_USAGE_TOKENS)
      .respondOk("end_turn"),
};

it.effect("0.21.1 false positive: model prose that PARSES as a compaction is left alone", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: FALSE_POSITIVE_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: FALSE_POSITIVE_THREAD, input: "сожми файлы" });
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    // No row …
    assert.isUndefined(
      compactionCompleted(collector.events),
      "THE BREAK: model prose was turned into a compaction row",
    );
    assert.isUndefined(
      collector.events.find(
        (e) =>
          e.type === "task.progress" && e.payload.taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX),
      ),
      "THE BREAK: model prose opened a compaction row",
    );
    // … and no ring write of the prose's numbers (200 / 3). The turn's own usage
    // frame is the only thing allowed to move the meter here.
    assert.deepStrictEqual(
      tokenUsage(collector.events).map((e) => e.payload.usage.usedTokens),
      [POST_TURN_USAGE_TOKENS],
      "THE BREAK: model prose moved the context ring",
    );
    // … and the text reached the bubble VERBATIM — swallowing it would delete
    // assistant output, which is worse than any missed notice.
    assert.include(deltaText(collector.events), MODEL_PROSE);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(falsePositiveScript),
        testServices("ru-code-q21-compress-false-positive-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Case 4b: the SESSION-CAP notice ────────────────────────────────────────
// qwen compacted, and the result STILL exceeds `model.sessionTokenLimit`: the
// send is dropped and the prompt resolves `max_tokens` (Session.ts:4432) with no
// model round.
//
// THE CAP NOTICE REPLACES THE COMPACTION NOTICE — the compaction's diagnostic is
// only BUILT at :4378-4392 and emitted at :4436-4440, which the cap's early
// return at :4432 never reaches. So the turn carries ONE frame. Binary-verified:
// with `sessionTokenLimit: 500` and a post-compaction count of 1008 the real
// binary sent `Session token limit exceeded: 1008 tokens > 500 limit. …` and
// nothing else (@ru-code/qwen-real-harness `session-token-limit`).
//
// What must hold, and it is the opposite of the success path: the row closes
// FAILED, and NO ring value is written — qwen reported no post-compaction size
// with this notice, and inventing one would move the meter to a number nothing
// measured.
const CAP_THREAD = ThreadId.make("qwen021-compress-session-cap");
const CAP_TOKENS = 1_008;
const CAP_LIMIT = 500;

const capScript: FakeAcpScript = {
  dialect: "v2",
  onPrompt: (steps) =>
    steps.emitSessionTokenLimit({ tokens: CAP_TOKENS, limit: CAP_LIMIT }).respondOk("max_tokens"),
};

it.effect("0.21.1 session-cap notice: a FAILED row, and no ring write at all", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const collector = yield* collectAdapterEvents(adapter);

    yield* adapter.startSession({
      threadId: CAP_THREAD,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: CAP_THREAD, input: "продолжай" });
    yield* Effect.sleep(SETTLE);
    yield* collector.stop;

    const completed = compactionCompleted(collector.events);
    assert.isDefined(completed, "the cap notice produced no compaction row at all");
    assert.strictEqual(completed!.payload.status, "failed");
    const summary = enText(completed!.payload.summary);
    assert.include(summary, "Qwen reported the session token limit was exceeded");
    // qwen's own sentence rides inside the localized wrapper.
    assert.include(summary, `Session token limit exceeded: ${String(CAP_TOKENS)} tokens`);
    // No numbers for the circuit breaker — there was no reported result.
    assert.isUndefined(completed!.payload.usage);
    // The raw English never reached the chat.
    assert.notInclude(deltaText(collector.events), "Session token limit exceeded");
    // And the ring did not move: nothing measured the post-compaction size.
    assert.deepStrictEqual(
      tokenUsage(collector.events).map((e) => e.payload.usage.usedTokens),
      [],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(capScript), testServices("ru-code-q21-compress-cap-")),
    ),
    TestClock.withLive,
  ),
);

// ── Case 5: a following turn must work, with NO ACP session restart ─────────
// A user-typed `/compress` is an ordinary turn as far as the adapter is
// concerned (`sendTurn`, not `compactContext`), so nothing may retire the
// session: exactly ONE `session/new`, no `session/load`, and turn 2's reply
// must land.

const NEXT_TURN_THREAD = ThreadId.make("qwen021-compress-next-turn");
const nextTurnPromptTexts: string[] = [];
const nextTurnSessionTrail: string[] = [];

const nextTurnScript: FakeAcpScript = {
  dialect: "v2",
  onCreateSession: () => nextTurnSessionTrail.push("<session/new>"),
  onLoadSession: (sessionId) => nextTurnSessionTrail.push(`<session/load ${sessionId}>`),
  onPromptText: (text) => nextTurnPromptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = nextTurnPromptTexts[nextTurnPromptTexts.length - 1];
    if (promptText === "/compress") {
      steps
        .emitCompressProgress()
        .emitCompressResult({ preTokens: PRE_TOKENS, postTokens: POST_TOKENS })
        .respondOk("end_turn");
      return;
    }
    steps
      .emitText(`Ответ: ${promptText ?? ""}`)
      .emitUsageChunk(POST_TURN_USAGE_TOKENS)
      .respondOk("end_turn");
  },
};

it.effect(
  "0.21.1 manual /compress: the NEXT turn answers over the SAME ACP session (no restart)",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: NEXT_TURN_THREAD,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: NEXT_TURN_THREAD, input: "/compress" });
      yield* Effect.sleep(SETTLE);
      yield* adapter.sendTurn({ threadId: NEXT_TURN_THREAD, input: "что дальше" });
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      assert.deepStrictEqual(
        nextTurnPromptTexts,
        ["/compress", "что дальше"],
        `both prompts must have reached the SAME agent; observed ${JSON.stringify(
          nextTurnPromptTexts,
        )}`,
      );
      assert.deepStrictEqual(
        nextTurnSessionTrail,
        ["<session/new>"],
        `THE BREAK (if it fires): the ACP session was re-established around the compress. ` +
          `Observed trail: ${JSON.stringify(nextTurnSessionTrail)}`,
      );
      assert.include(
        deltaText(collector.events),
        "Ответ: что дальше",
        "the post-compress turn's reply never reached the runtime events",
      );
      // And the ring must have snapped to the compaction size at some point.
      assert.isAtLeast(
        tokenUsage(collector.events).filter((e) => e.payload.usage.usedTokens === POST_TOKENS)
          .length,
        1,
        `THE BREAK: no thread.token-usage.updated carried the post-compaction size ` +
          `${String(POST_TOKENS)}. Observed: ${JSON.stringify(
            tokenUsage(collector.events).map((e) => e.payload.usage),
          )}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(nextTurnScript),
          testServices("ru-code-q21-compress-next-"),
        ),
      ),
      TestClock.withLive,
    ),
);

// ── Case 6: TWO sessions — compression in one must not move the other's ring ─
// Both threads run on the SAME adapter (the production shape: one adapter, one
// session per thread). Thread A compresses; thread B only ever had a plain turn,
// so every token-usage event carrying the compaction size must be A's, and B's
// must stay at its own turn's usage.

const MULTI_A = ThreadId.make("qwen021-compress-multi-a");
const MULTI_B = ThreadId.make("qwen021-compress-multi-b");
const B_TURN_TOKENS = 4_242;

const multiPromptTexts: string[] = [];

const multiScript: FakeAcpScript = {
  dialect: "v2",
  onPromptText: (text) => multiPromptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = multiPromptTexts[multiPromptTexts.length - 1];
    if (promptText === "/compress") {
      steps
        .emitCompressProgress()
        .emitCompressResult({ preTokens: PRE_TOKENS, postTokens: POST_TOKENS })
        .respondOk("end_turn");
      return;
    }
    steps.emitText("ок").emitUsageChunk(B_TURN_TOKENS).respondOk("end_turn");
  },
};

it.effect(
  "0.21.1 two sessions: compression in thread A updates A's ring and leaves B's untouched",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);

      yield* adapter.startSession({
        threadId: MULTI_A,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.startSession({
        threadId: MULTI_B,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // B establishes its own baseline FIRST, so a later cross-talk write would
      // be visible as a second B event rather than as B's only one.
      yield* adapter.sendTurn({ threadId: MULTI_B, input: "привет" });
      yield* Effect.sleep(SETTLE);
      yield* adapter.sendTurn({ threadId: MULTI_A, input: "/compress" });
      yield* Effect.sleep(SETTLE);
      yield* collector.stop;

      const forA = tokenUsage(collector.events).filter((e) => e.threadId === MULTI_A);
      const forB = tokenUsage(collector.events).filter((e) => e.threadId === MULTI_B);

      // B: untouched — exactly its own turn's usage, nothing from A's compaction.
      assert.deepStrictEqual(
        forB.map((e) => e.payload.usage.usedTokens),
        [B_TURN_TOKENS],
        `thread B's ring must carry ONLY its own turn usage; observed ${JSON.stringify(
          forB.map((e) => e.payload.usage.usedTokens),
        )}`,
      );

      // A: snapped to the post-compaction size. THIS is the assertion that breaks.
      assert.deepStrictEqual(
        forA.map((e) => e.payload.usage.usedTokens),
        [POST_TOKENS],
        `THE BREAK: thread A's ring never received the post-compaction size ` +
          `${String(POST_TOKENS)}. Observed A=${JSON.stringify(
            forA.map((e) => e.payload.usage.usedTokens),
          )} B=${JSON.stringify(forB.map((e) => e.payload.usage.usedTokens))}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(multiScript),
          testServices("ru-code-q21-compress-multi-"),
        ),
      ),
      TestClock.withLive,
    ),
);
