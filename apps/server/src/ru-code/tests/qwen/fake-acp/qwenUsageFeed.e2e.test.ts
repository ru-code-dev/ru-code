// ru-code: live token-feed proof. Drives the REAL QwenAdapter over the in-memory
// fake ACP agent. The fake streams agent_message_chunks carrying running usage on
// `update._meta.usage.inputTokens` (exactly where qwen stamps its promptTokenCount);
// the adapter's ContentDelta path must convert each CHANGED value into a
// `thread.token-usage.updated` event (maxTokens = CONTEXT_WINDOW_TOKENS), deduped
// against the session cursor, and emit NOTHING for a repeat value or a chunk with
// no usage. Modelled on planApproval.e2e.test.ts (direct adapter + streamEvents).
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

import { CONTEXT_WINDOW_TOKENS } from "@ru-code/qwen/constants";
import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-usage-thread");
// A unique final chunk used as an ordering barrier: once the adapter has emitted
// this content.delta, every earlier usage chunk has been processed by the same
// (ordered) notification fiber, so the token-usage assertions are race-free.
const SENTINEL = "USAGE_FEED_SENTINEL_DONE";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-usage-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// 1000 → emit; 1500 → emit; 1500 again → dedupe (no emit); no _meta → no emit.
const script: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      .emitTextWithUsage("a", 1000)
      .emitTextWithUsage("b", 1500)
      .emitTextWithUsage("c", 1500)
      .emitText("d")
      .emitText(SENTINEL)
      .respondOk(),
};

type TokenUsage = Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;

it.effect(
  "qwen usage feed: emits token-usage per CHANGED inputTokens, dedupes repeats, ignores no-usage chunks",
  () =>
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

      // The turn completes on respondOk (no parked request); the notification fiber
      // drains concurrently, so gate the assertions on the sentinel barrier.
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "count my tokens" });
      yield* Deferred.await(sentinelSeen).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      const usageEvents = events.filter(
        (e): e is TokenUsage => e.type === "thread.token-usage.updated",
      );

      // Exactly two emits: 1000 then 1500. The repeat 1500 (dedupe) and the
      // usage-less chunk each contribute nothing.
      assert.lengthOf(usageEvents, 2);
      assert.strictEqual(usageEvents[0]!.payload.usage.usedTokens, 1000);
      assert.strictEqual(usageEvents[1]!.payload.usage.usedTokens, 1500);
      // maxTokens is the hardcoded context window on every emit.
      assert.strictEqual(usageEvents[0]!.payload.usage.maxTokens, CONTEXT_WINDOW_TOKENS);
      assert.strictEqual(usageEvents[1]!.payload.usage.maxTokens, CONTEXT_WINDOW_TOKENS);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    ),
);
