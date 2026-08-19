// ru-code: BUG-PROOF (intentionally FAILING in port). Live token-feed against the
// REAL qwen usage contract. Unlike qwenUsageFeed.e2e.test.ts (which stamps usage on
// a NON-EMPTY text chunk via emitTextWithUsage — a shape qwen never emits), qwen
// attaches usage ONLY to a dedicated agent_message_chunk whose content.text is ""
// (empty), once per model-response stream after the text loop
// (qwen-code packages/cli/src/acp-integration/session/emitters/MessageEmitter.ts:77-101
// `emitUsageMetadata` called with text=''; Session.ts:341-348). qwen's own vscode
// consumer reads usage UNCONDITIONALLY, outside the `if (text)` guard
// (qwenSessionUpdateHandler.ts:68-79).
//
// The port drops it: AcpRuntimeModel.ts:567-576 emits a ContentDelta ONLY for
// text.length > 0 and does NO usage extraction; the adapter extracts usage only
// inside its ContentDelta branch (QwenAdapter.ts:1306-1330). So the empty-text
// usage frame yields no ContentDelta → extractQwenInputTokens never runs → NO
// thread.token-usage.updated. That is why the context ring only moves after
// /compress (a separate emit path), never live.
//
// This test asserts the CORRECT behavior (a usage event IS emitted for the real
// empty-text frame) so it FAILS today and PASSES once usage extraction is moved
// to fire on every agent_message_chunk regardless of text. Do NOT weaken it.
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
const THREAD_ID = ThreadId.make("qwen-usage-real-frame-thread");
// Ordering barrier: the empty-text usage frame emits NO content.delta, so we append
// a real text chunk as the barrier. The ordered notification fiber processes the
// usage frame before this sentinel, making the assertion race-free.
const SENTINEL = "USAGE_REAL_FRAME_SENTINEL_DONE";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-usage-real-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Real qwen shape: some assistant text (no usage), then the dedicated empty-text
// usage frame carrying inputTokens=4242, then the barrier text.
const script: FakeAcpScript = {
  onPrompt: (steps) =>
    steps.emitText("working…").emitUsageChunk(4242).emitText(SENTINEL).respondOk(),
};

type TokenUsage = Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;

it.effect("qwen live token feed: emits token-usage for the REAL empty-text usage frame", () =>
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

    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "count my tokens" });
    yield* Deferred.await(sentinelSeen).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    const usageEvents = events.filter(
      (e): e is TokenUsage => e.type === "thread.token-usage.updated",
    );

    // The real empty-text usage frame must produce exactly one live usage update.
    // FAILS in port (0 emitted — the frame carries no text so ContentDelta, and
    // therefore usage extraction, never fires).
    assert.isAtLeast(
      usageEvents.length,
      1,
      "no live token-usage emitted for the real qwen usage frame",
    );
    assert.strictEqual(usageEvents[usageEvents.length - 1]!.payload.usage.usedTokens, 4242);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  ),
);
