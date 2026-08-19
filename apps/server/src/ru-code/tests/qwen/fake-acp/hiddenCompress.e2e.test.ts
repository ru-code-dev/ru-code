// ru-code: END-TO-END hidden context compaction (compactContext) + the
// auto-compact trigger + the circuit breaker, against the REAL qwen wire
// shapes. The timeline contract is ONE morphing row per compaction:
//   - `task.progress` under a `context-compaction:`-prefixed taskId, emitted
//     BEFORE the hidden "/compress" prompt (the row appears immediately);
//   - `task.completed` with the SAME taskId carrying the outcome:
//       success  → «Compaction succeeded (X -> Y).»
//       breaker  → tone "warning", «Compaction barely reduced the context …»
//       failure  → status "failed" with the provider's message;
//   - NO thread.state.changed{compacted} (replaced by the task pair), and the
//     call itself never fails once the progress row is out;
//   - sending a turn WHILE a compaction runs fails fast with the B5 text.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { isAutoCompactDisarmed } from "../../../qwen/compaction/compactionHistory.ts";
import { COMPRESS_IN_PROGRESS_DETAIL } from "../../../qwen/errors/recognizers.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const COMPRESS_METHOD = "_qwencode/slash_command";

const testServices = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

const collectEvents = (adapter: { streamEvents: Stream.Stream<ProviderRuntimeEvent> }) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
    );
    return { events, stop: Effect.asVoid(Fiber.interrupt(fiber)) };
  });

type TaskProgressEvent = Extract<ProviderRuntimeEvent, { type: "task.progress" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;

const isCompactionProgress = (event: ProviderRuntimeEvent): event is TaskProgressEvent =>
  event.type === "task.progress" && event.payload.taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX);

const isCompactionCompleted = (event: ProviderRuntimeEvent): event is TaskCompletedEvent =>
  event.type === "task.completed" &&
  event.payload.taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX);

const isCompactedStateChange = (event: ProviderRuntimeEvent) =>
  event.type === "thread.state.changed" && event.payload.state === "compacted";

// Script for a compactContext call: the prompt is the hidden "/compress"; the
// fake streams the REAL compress frames and ends the turn.
const compressScript = (input: {
  readonly promptTexts: string[];
  readonly outcome: "success" | "error" | "silent";
}): FakeAcpScript => ({
  onPromptText: (text) => input.promptTexts.push(text),
  onPrompt: (steps) => {
    if (input.outcome === "error") {
      steps
        .emitExtNotification(COMPRESS_METHOD, {
          message: "Failed to compress chat history.",
          messageType: "error",
        })
        .respondOk();
      return;
    }
    if (input.outcome === "silent") {
      // No compress frames at all — the "provider never confirmed" path.
      steps.respondOk();
      return;
    }
    steps
      .emitExtNotification(COMPRESS_METHOD, {
        message: "Compressing context...",
        messageType: "info",
      })
      .emitExtNotification(COMPRESS_METHOD, {
        message: "Context compressed (200000 -> 12345)",
        messageType: "info",
      })
      .respondOk();
  },
});

const THREAD_BUTTON = ThreadId.make("hidden-compress-button");
const buttonPromptTexts: string[] = [];

it.effect("compactContext: ONE morphing row — progress before the prompt, success completion", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: THREAD_BUTTON,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.compactContext!(THREAD_BUTTON);
    yield* stop;

    // The wire carried exactly the hidden "/compress" prompt.
    assert.deepStrictEqual(buttonPromptTexts, ["/compress"]);

    // The spinner row: emitted with the compaction taskId and the RU text.
    const progress = events.find(isCompactionProgress);
    assert.isDefined(progress, "no compaction task.progress emitted");
    assert.strictEqual(progress!.payload.description, "Compacting context…");

    // The end state: SAME taskId, completed, the numbers in the summary.
    const completed = events.find(isCompactionCompleted);
    assert.isDefined(completed, "no compaction task.completed emitted");
    assert.strictEqual(completed!.payload.taskId, progress!.payload.taskId);
    assert.strictEqual(completed!.payload.status, "completed");
    assert.strictEqual(completed!.payload.summary, "Compaction succeeded (200000 -> 12345).");
    assert.isUndefined(completed!.payload.tone);
    // Raw numbers persist with the row — the breaker's restart-proof state.
    assert.deepStrictEqual(completed!.payload.usage, { preTokens: 200_000, postTokens: 12_345 });

    // Ordering: the row appears BEFORE the outcome (progress precedes completed).
    assert.isBelow(events.indexOf(progress!), events.indexOf(completed!));

    // The legacy thread.state.changed{compacted} emit is REPLACED, not doubled.
    assert.isUndefined(events.find(isCompactedStateChange));

    // Meter surface: the post-compaction size.
    const usage = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
        event.type === "thread.token-usage.updated",
    );
    assert.isAtLeast(usage.length, 1, "no token-usage update emitted");
    assert.strictEqual(usage[usage.length - 1]!.payload.usage.usedTokens, 12_345);

    // Hidden: NOTHING landed in a bubble and no turn lifecycle ran.
    assert.isUndefined(events.find((event) => event.type === "content.delta"));
    assert.isUndefined(events.find((event) => event.type === "turn.completed"));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(compressScript({ promptTexts: buttonPromptTexts, outcome: "success" })),
        testServices("ru-code-hidden-compress-"),
      ),
    ),
    TestClock.withLive,
  ),
);

const THREAD_ERROR = ThreadId.make("hidden-compress-error");

it.effect(
  "compactContext: a compress error ends the SAME row as failed — the call itself succeeds",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const { events, stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ERROR,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // Once the progress row is out the call NEVER fails (a thrown error would
      // add the reactor's failure row next to the task row — two rows).
      const exit = yield* Effect.exit(adapter.compactContext!(THREAD_ERROR));
      yield* stop;

      assert.isTrue(exit._tag === "Success", "compactContext must not fail after the row started");
      const progress = events.find(isCompactionProgress);
      const completed = events.find(isCompactionCompleted);
      assert.isDefined(progress);
      assert.isDefined(completed);
      assert.strictEqual(completed!.payload.taskId, progress!.payload.taskId);
      assert.strictEqual(completed!.payload.status, "failed");
      assert.strictEqual(completed!.payload.summary, "Failed to compress chat history.");
      assert.isUndefined(events.find(isCompactedStateChange));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(compressScript({ promptTexts: [], outcome: "error" })),
          testServices("ru-code-hidden-compress-error-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const THREAD_SILENT = ThreadId.make("hidden-compress-silent");

it.effect("compactContext: an unconfirmed compress (no frames) ends the row as failed", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: THREAD_SILENT,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.compactContext!(THREAD_SILENT);
    yield* stop;

    const completed = events.find(isCompactionCompleted);
    assert.isDefined(completed);
    assert.strictEqual(completed!.payload.status, "failed");
    assert.strictEqual(
      completed!.payload.summary,
      "The provider did not confirm context compaction (stopReason: end_turn).",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(compressScript({ promptTexts: [], outcome: "silent" })),
        testServices("ru-code-hidden-compress-silent-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Circuit breaker ─────────────────────────────────────────────────────────
// Default window (no discovery) = 252_000: disarm line 151_200 (60%), auto
// trigger 189_000 (75%). The breaker state is DERIVED from persisted history:
// the adapter reads it through `getThreadCompactionState` (in production bound
// to the projection query), so the canned states below are exactly what a
// server restart would re-derive — these tests prove restart persistence.

const BREAKER_TRIP_TEXT =
  "Compaction barely reduced the context (200000 -> 199000). Auto-compaction disabled.";
const COMPACTION_ADVICE_DETAIL =
  "Compacting an already-compacted or short conversation is ineffective — the CLI needs " +
  "new messages for compaction to help. Continue the conversation, pick a model with a " +
  "larger context, or start a new conversation.";

const TRIPPED_COMPACTION = { preTokens: 200_000, postTokens: 199_000 };

const breakerScript = (promptTexts: string[]): FakeAcpScript => ({
  onPromptText: (text) => promptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = promptTexts[promptTexts.length - 1];
    if (promptText === "/compress") {
      steps
        .emitExtNotification(COMPRESS_METHOD, {
          message: "Context compressed (199000 -> 9000)",
          messageType: "info",
        })
        .respondOk();
      return;
    }
    // User turns encode their post-turn usage in the prompt text: "usage:<n>".
    const requestedUsage = Number(/^usage:(\d+)$/.exec(promptText ?? "")?.[1] ?? "0");
    steps.emitUsageChunk(requestedUsage).emitText("done").respondOk();
  },
});

const settleAutoCompactFork = Effect.sleep("60 millis");

const THREAD_TRIP_ROW = ThreadId.make("hidden-compress-trip-row");
const tripRowPromptTexts: string[] = [];

it.effect(
  "breaker: a near-no-op compress ends the row as WARNING and persists the raw numbers",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const { events, stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_TRIP_ROW,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // Manual compress barely shrinks (200000 -> 199000 ≥ 60% of 252000).
      yield* adapter.compactContext!(THREAD_TRIP_ROW);
      yield* stop;

      assert.deepStrictEqual(tripRowPromptTexts, ["/compress"]);
      const trip = events.find(isCompactionCompleted);
      assert.isDefined(trip, "no breaker completion row");
      assert.strictEqual(trip!.payload.status, "completed");
      assert.strictEqual(trip!.payload.tone, "warning");
      assert.strictEqual(trip!.payload.summary, BREAKER_TRIP_TEXT);
      // The advice rides separately: visible title + expandable body on the web.
      assert.strictEqual(trip!.payload.detail, COMPACTION_ADVICE_DETAIL);
      // The numbers ride the event — this is the breaker state the projection
      // persists and `getThreadCompactionState` re-derives after a restart.
      assert.deepStrictEqual(trip!.payload.usage, TRIPPED_COMPACTION);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer({
            onPromptText: (text) => tripRowPromptTexts.push(text),
            onPrompt: (steps) =>
              steps
                .emitExtNotification(COMPRESS_METHOD, {
                  message: "Context compressed (200000 -> 199000)",
                  messageType: "info",
                })
                .respondOk(),
          }),
          testServices("ru-code-hidden-compress-trip-row-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const THREAD_INEFFECTIVE = ThreadId.make("hidden-compress-ineffective");
const ineffectivePromptTexts: string[] = [];

it.effect(
  "ineffective below the gate: WARNING row with advice detail, auto-compact stays armed",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const { events, stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_INEFFECTIVE,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // Compression GREW the context (15762 -> 16246) but stays far below the
      // 60% gate (151_200 of the default 252_000 window): advice, no disarm.
      yield* adapter.compactContext!(THREAD_INEFFECTIVE);
      yield* stop;

      assert.deepStrictEqual(ineffectivePromptTexts, ["/compress"]);
      const row = events.find(isCompactionCompleted);
      assert.isDefined(row, "no completion row");
      assert.strictEqual(row!.payload.status, "completed");
      assert.strictEqual(row!.payload.tone, "warning");
      assert.strictEqual(
        row!.payload.summary,
        "Compaction did not reduce the context (15762 -> 16246).",
      );
      assert.strictEqual(row!.payload.detail, COMPACTION_ADVICE_DETAIL);
      assert.deepStrictEqual(row!.payload.usage, { preTokens: 15_762, postTokens: 16_246 });
      // The persisted numbers sit far below the disarm line — the history-derived
      // breaker state stays ARMED (only the 60% gate disarms).
      assert.isFalse(
        isAutoCompactDisarmed(
          { lastCompaction: { preTokens: 15_762, postTokens: 16_246 }, minUsedTokensSince: null },
          252_000 * 0.6,
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer({
            onPromptText: (text) => ineffectivePromptTexts.push(text),
            onPrompt: (steps) =>
              steps
                .emitExtNotification(COMPRESS_METHOD, {
                  message: "Context compressed (15762 -> 16246)",
                  messageType: "info",
                })
                .respondOk(),
          }),
          testServices("ru-code-hidden-compress-ineffective-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const THREAD_SMALL_DIALOG = ThreadId.make("hidden-compress-small-dialog");
const smallDialogPromptTexts: string[] = [];

it.effect(
  "gain is measured against the dialog, not the window: shrinking a small dialog is SUCCESS",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const { events, stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_SMALL_DIALOG,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // 12000 -> 2000 frees 83% of the dialog but only ~4% of the 252_000
      // window — a window-relative threshold brands it «did not reduce the context»
      // (the field report: 61379 -> 26361 on a 1M-window model). Effectiveness
      // must compare against preTokens.
      yield* adapter.compactContext!(THREAD_SMALL_DIALOG);
      yield* stop;

      assert.deepStrictEqual(smallDialogPromptTexts, ["/compress"]);
      const row = events.find(isCompactionCompleted);
      assert.isDefined(row, "no completion row");
      assert.strictEqual(row!.payload.status, "completed");
      assert.strictEqual(row!.payload.summary, "Compaction succeeded (12000 -> 2000).");
      assert.isUndefined(row!.payload.tone);
      assert.isUndefined(row!.payload.detail);
      assert.deepStrictEqual(row!.payload.usage, { preTokens: 12_000, postTokens: 2_000 });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer({
            onPromptText: (text) => smallDialogPromptTexts.push(text),
            onPrompt: (steps) =>
              steps
                .emitExtNotification(COMPRESS_METHOD, {
                  message: "Context compressed (12000 -> 2000)",
                  messageType: "info",
                })
                .respondOk(),
          }),
          testServices("ru-code-hidden-compress-small-dialog-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const THREAD_BREAKER = ThreadId.make("hidden-compress-breaker");
const breakerPromptTexts: string[] = [];

it.effect(
  "breaker: tripped persisted state disarms auto-compact (survives restart by construction)",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        getAutoCompactContext: Effect.succeed(true),
        // What the history reader would return after the trip — usage never
        // dipped below the 151_200 disarm line since.
        getThreadCompactionState: () =>
          Effect.succeed({ lastCompaction: TRIPPED_COMPACTION, minUsedTokensSince: 199_000 }),
      });
      const { stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_BREAKER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // A turn ending ≥75% full must NOT auto-fire while disarmed.
      yield* adapter.sendTurn({ threadId: THREAD_BREAKER, input: "usage:199000" });
      yield* settleAutoCompactFork;
      assert.deepStrictEqual(breakerPromptTexts, ["usage:199000"]);
      yield* stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(breakerScript(breakerPromptTexts)),
          testServices("ru-code-hidden-compress-breaker-"),
        ),
      ),
      TestClock.withLive,
    ),
);

const THREAD_REARM = ThreadId.make("hidden-compress-rearm");
const rearmPromptTexts: string[] = [];

it.effect("breaker: a usage dip below 60% in persisted history re-arms auto-compact", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      getAutoCompactContext: Effect.succeed(true),
      // Same trip, but the history shows usage dropped to 100_000 since —
      // compression can help again.
      getThreadCompactionState: () =>
        Effect.succeed({ lastCompaction: TRIPPED_COMPACTION, minUsedTokensSince: 100_000 }),
    });
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: THREAD_REARM,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    // A heavy turn (199000 ≥ 189000) fires the hidden compress again.
    yield* adapter.sendTurn({ threadId: THREAD_REARM, input: "usage:199000" });
    let attempt = 0;
    while (attempt < 250 && rearmPromptTexts.length < 2) {
      yield* Effect.sleep("20 millis");
      attempt += 1;
    }
    assert.deepStrictEqual(rearmPromptTexts, ["usage:199000", "/compress"]);

    // The compress is effective (→ 9000) → a SUCCESS completion row.
    const completed = events.find(isCompactionCompleted);
    assert.isDefined(completed);
    assert.strictEqual(completed!.payload.status, "completed");
    assert.strictEqual(completed!.payload.summary, "Compaction succeeded (199000 -> 9000).");
    assert.isUndefined(completed!.payload.tone);
    yield* stop;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(breakerScript(rearmPromptTexts)),
        testServices("ru-code-hidden-compress-rearm-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Crash paths: child exit / fiber interruption ────────────────────────────

const THREAD_CHILD_EXIT = ThreadId.make("hidden-compress-child-exit");

it.effect("child crash mid-compress: the row ends as failed, the call itself succeeds", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: THREAD_CHILD_EXIT,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    const exit = yield* Effect.exit(adapter.compactContext!(THREAD_CHILD_EXIT));
    yield* stop;

    assert.isTrue(exit._tag === "Success", "compactContext must not fail after the row started");
    const progress = events.find(isCompactionProgress);
    const completed = events.find(isCompactionCompleted);
    assert.isDefined(progress);
    assert.isDefined(completed, "no closing row after the child died");
    assert.strictEqual(completed!.payload.taskId, progress!.payload.taskId);
    assert.strictEqual(completed!.payload.status, "failed");
    assert.isTrue(
      completed!.payload.summary!.startsWith("Could not compact the context:"),
      `unexpected summary: ${completed!.payload.summary}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer({
          onPrompt: (steps) => {
            steps.emitExtNotification(COMPRESS_METHOD, {
              message: "Compressing context...",
              messageType: "info",
            });
            // The qwen child dies mid-compression.
            steps.exit(1);
          },
        }),
        testServices("ru-code-hidden-compress-child-exit-"),
      ),
    ),
    TestClock.withLive,
  ),
);

const THREAD_INTERRUPT = ThreadId.make("hidden-compress-interrupt");
const interruptPromptTexts: string[] = [];

it.effect("fiber interruption mid-compress: the row closes as stopped and send unblocks", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: THREAD_INTERRUPT,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    const compactFiber = yield* Effect.forkChild(adapter.compactContext!(THREAD_INTERRUPT));
    let attempt = 0;
    while (attempt < 250 && !events.some(isCompactionProgress)) {
      yield* Effect.sleep("20 millis");
      attempt += 1;
    }
    assert.isTrue(events.some(isCompactionProgress), "compaction never started");

    // Session teardown / instance rebuild / stopAll present as fiber interrupt.
    yield* Fiber.interrupt(compactFiber);

    const progress = events.find(isCompactionProgress);
    const completed = events.find(isCompactionCompleted);
    assert.isDefined(completed, "interruption left the row dangling");
    assert.strictEqual(completed!.payload.taskId, progress!.payload.taskId);
    assert.strictEqual(completed!.payload.status, "stopped");
    assert.strictEqual(completed!.payload.summary, "Compaction interrupted.");

    // The compress flag is released: the next send reaches the wire instead of
    // failing fast with B5.
    yield* adapter.sendTurn({ threadId: THREAD_INTERRUPT, input: "after interrupt" });
    const turnCompleted = events.find(
      (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed",
    );
    assert.isDefined(turnCompleted);
    assert.strictEqual(turnCompleted!.payload.state, "completed");
    assert.deepStrictEqual(interruptPromptTexts, ["/compress", "after interrupt"]);
    yield* stop;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer({
          onPromptText: (text) => interruptPromptTexts.push(text),
          onPrompt: (steps) => {
            const promptText = interruptPromptTexts[interruptPromptTexts.length - 1];
            if (promptText === "/compress") {
              // Parks — the compaction stays in flight until the interrupt.
              steps.emitExtNotification(COMPRESS_METHOD, {
                message: "Compressing context...",
                messageType: "info",
              });
              return;
            }
            steps.emitText("ok").respondOk();
          },
        }),
        testServices("ru-code-hidden-compress-interrupt-"),
      ),
    ),
    TestClock.withLive,
  ),
);

// ── Fail-fast send during compression ───────────────────────────────────────

const THREAD_FAILFAST = ThreadId.make("hidden-compress-failfast");
const failFastPromptTexts: string[] = [];

// The "/compress" prompt PARKS (no terminal step) so the compaction stays in
// flight while the test sends a turn.
const parkedCompressScript: FakeAcpScript = {
  onPromptText: (text) => failFastPromptTexts.push(text),
  onPrompt: (steps) => {
    steps.emitExtNotification(COMPRESS_METHOD, {
      message: "Compressing context...",
      messageType: "info",
    });
    // no respondOk → the prompt parks until teardown
  },
};

it.effect(
  "fail-fast: sending during a compaction fails the turn with the B5 text (row + banner)",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const { events, stop } = yield* collectEvents(adapter);

      yield* adapter.startSession({
        threadId: THREAD_FAILFAST,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const compactFiber = yield* Effect.forkChild(adapter.compactContext!(THREAD_FAILFAST));

      // Wait until the compaction is genuinely in flight (progress row emitted).
      let attempt = 0;
      while (attempt < 250 && !events.some(isCompactionProgress)) {
        yield* Effect.sleep("20 millis");
        attempt += 1;
      }
      assert.isTrue(events.some(isCompactionProgress), "compaction never started");

      yield* Effect.exit(
        adapter.sendTurn({ threadId: THREAD_FAILFAST, input: "hello mid-compress" }),
      );

      // The turn failed with the classified B5 text on BOTH surfaces: the banner
      // rides turn.completed (showNotification), the row rides task.completed.
      const turnCompleted = events.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.isDefined(turnCompleted, "no turn.completed for the failed send");
      assert.strictEqual(turnCompleted!.payload.state, "failed");
      assert.strictEqual(turnCompleted!.payload.errorMessage, COMPRESS_IN_PROGRESS_DETAIL);
      assert.strictEqual(turnCompleted!.payload.showNotification, true);

      // The failed-send row carries the turn's own id as taskId (the finalize
      // path) — matched exactly, not by elimination.
      const failedRow = events.find(
        (event): event is TaskCompletedEvent =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === String(turnCompleted!.turnId),
      );
      assert.isDefined(failedRow, "no timeline row for the failed send");
      assert.strictEqual(failedRow!.payload.status, "failed");
      assert.strictEqual(failedRow!.payload.summary, COMPRESS_IN_PROGRESS_DETAIL);

      // The guard fired BEFORE any prompt went to the wire — only the hidden
      // "/compress" ever reached the fake.
      assert.deepStrictEqual(failFastPromptTexts, ["/compress"]);

      yield* Fiber.interrupt(compactFiber);
      yield* stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(parkedCompressScript),
          testServices("ru-code-hidden-compress-failfast-"),
        ),
      ),
      TestClock.withLive,
    ),
);

// ── Auto-compact on/off ─────────────────────────────────────────────────────
// One script drives BOTH prompts: the user turn ends with usage at ~79% of the
// default 252_000 window (199_000 tokens); the auto-triggered second prompt is
// the hidden "/compress".
const autoScript = (promptTexts: string[]): FakeAcpScript => {
  let promptIndex = 0;
  return {
    onPromptText: (text) => promptTexts.push(text),
    onPrompt: (steps) => {
      promptIndex += 1;
      if (promptIndex === 1) {
        steps.emitUsageChunk(199_000).emitText("done working").respondOk();
        return;
      }
      steps
        .emitExtNotification(COMPRESS_METHOD, {
          message: "Context compressed (199000 -> 9000)",
          messageType: "info",
        })
        .respondOk();
    },
  };
};

const runAutoScenario = (input: {
  readonly threadId: ThreadId;
  readonly autoCompactEnabled: boolean;
  readonly pollAttempts: number;
}) =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      getAutoCompactContext: Effect.succeed(input.autoCompactEnabled),
    });
    const { events, stop } = yield* collectEvents(adapter);

    yield* adapter.startSession({
      threadId: input.threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: input.threadId, input: "do heavy work" });

    // The auto-compact fork runs after the turn settles; poll instead of a
    // fixed sleep (bounded — the OFF case just exhausts its short budget).
    let attempt = 0;
    while (attempt < input.pollAttempts && !events.some(isCompactionCompleted)) {
      yield* Effect.sleep("20 millis");
      attempt += 1;
    }
    yield* stop;
    return events;
  });

const THREAD_AUTO_ON = ThreadId.make("hidden-compress-auto-on");
const autoOnPromptTexts: string[] = [];

it.effect("auto-compact: a turn ending ≥75% full fires the hidden /compress", () =>
  Effect.gen(function* () {
    const events = yield* runAutoScenario({
      threadId: THREAD_AUTO_ON,
      autoCompactEnabled: true,
      pollAttempts: 250,
    });

    assert.deepStrictEqual(autoOnPromptTexts, ["do heavy work", "/compress"]);
    const completed = events.find(isCompactionCompleted);
    assert.isDefined(completed, "auto-compact did not emit the completion row");
    assert.strictEqual(completed!.payload.summary, "Compaction succeeded (199000 -> 9000).");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(autoScript(autoOnPromptTexts)),
        testServices("ru-code-hidden-compress-auto-on-"),
      ),
    ),
    TestClock.withLive,
  ),
);

const THREAD_AUTO_OFF = ThreadId.make("hidden-compress-auto-off");
const autoOffPromptTexts: string[] = [];

it.effect("auto-compact: setting OFF never fires the hidden /compress", () =>
  Effect.gen(function* () {
    const events = yield* runAutoScenario({
      threadId: THREAD_AUTO_OFF,
      autoCompactEnabled: false,
      pollAttempts: 15,
    });

    assert.deepStrictEqual(autoOffPromptTexts, ["do heavy work"]);
    assert.isUndefined(events.find(isCompactionProgress));
    assert.isUndefined(events.find(isCompactionCompleted));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(autoScript(autoOffPromptTexts)),
        testServices("ru-code-hidden-compress-auto-off-"),
      ),
    ),
    TestClock.withLive,
  ),
);
