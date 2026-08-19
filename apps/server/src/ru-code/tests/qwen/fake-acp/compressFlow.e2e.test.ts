// ru-code: /compress flow proof (feature #3/#9 slash-command feed / S7). Drives the
// REAL QwenAdapter over the in-memory fake ACP agent: the agent emits qwen's
// vendor-extension slash-command notification (`_qwencode/slash_command`) carrying the
// raw English "Context compressed (X -> Y)" result. The adapter's
// handleUnknownExtNotification path must (a) LOCALIZE it into a compaction bubble
// (content.delta) and (b) emit a `thread.token-usage.updated` snapping the meter to
// the post-compaction size Y (maxTokens = CONTEXT_WINDOW_TOKENS).
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
const THREAD_ID = ThreadId.make("qwen-compress-thread");
// qwen 0.13.1's own vendor namespace; the adapter matches the `/slash_command`
// suffix, so any fork prefix rides the same path.
const COMPRESS_METHOD = "_qwencode/slash_command";
const PRE_TOKENS = 1000;
const POST_TOKENS = 400;

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-compress-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

type TokenUsage = Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;

const script: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      // qwen streams the compaction result as a raw, non-localized English string.
      .emitExtNotification(COMPRESS_METHOD, {
        message: `Context compressed (${PRE_TOKENS} -> ${POST_TOKENS})`,
        messageType: "info",
      })
      .respondOk(),
};

it.effect(
  "qwen /compress: localizes the compaction bubble and updates the token meter to the post size",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const events: ProviderRuntimeEvent[] = [];
      // Gate on the post-compaction token-usage emit (the ext-notification handler
      // runs on a separate dispatch path from turn.completed, so wait for the event
      // itself rather than assuming ordering vs the turn lifecycle).
      const meterUpdated = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "thread.token-usage.updated" &&
              event.payload.usage.usedTokens === POST_TOKENS
              ? Deferred.succeed(meterUpdated, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/compress" });
      yield* Deferred.await(meterUpdated).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      // (a) Localized compaction bubble carrying the X -> Y counts.
      const compactionBubble = events.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          e.type === "content.delta" &&
          e.payload.delta.includes(`Compaction succeeded (${PRE_TOKENS} -> ${POST_TOKENS})`),
      );
      assert.isDefined(
        compactionBubble,
        "the raw English compaction result was localized to our surface string",
      );

      // (b) A token-usage update snapping the meter to the post-compaction size.
      const meterEvents = events.filter(
        (e): e is TokenUsage =>
          e.type === "thread.token-usage.updated" && e.payload.usage.usedTokens === POST_TOKENS,
      );
      assert.isAtLeast(meterEvents.length, 1);
      assert.strictEqual(meterEvents[0]!.payload.usage.usedTokens, POST_TOKENS);
      assert.strictEqual(meterEvents[0]!.payload.usage.maxTokens, CONTEXT_WINDOW_TOKENS);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    ),
);
