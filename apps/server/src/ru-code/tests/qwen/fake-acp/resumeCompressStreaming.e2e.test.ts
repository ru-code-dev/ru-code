// ru-code: reproduction harness for the live 17:23 report — on a RESUMED
// session (real qwen replays the whole history as session/update notifications
// DURING session/load), after a HIDDEN compression (the meter button and the
// composer's `/compress` both call compactContext), the next regular turn's
// response allegedly never surfaces: the model streams, the UI shows nothing.
// This pins the adapter/runtime half of that pipeline.
//
// ru-code (qwen-compression wave): the flow lost a hop. A confirmed compression
// used to RETIRE the session, so the sequence was resume+replay → compress
// (session ends) → resume again (replay again) → turn. qwen 0.21.1 swaps the
// compressed chat into the LIVE session (see compactionKeepsSession.e2e.test.ts),
// so the session survives and the next turn goes straight out on it: one
// session/load window, not two. The surviving contract is the one that matters
// here — the replayed history must not surface as this turn's deltas, and the
// turn must emit its content.delta and assistant item events attributed to it.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
// ru-code (qwen-compression wave): the compress steps below speak qwen 0.21.1's
// ONLY channel — `session/update` `agent_message_chunk` +
// `_meta.source:"slash_command"` (MessageEmitter.ts:152-165). The vendor
// notification `_qwencode/slash_command` this suite used to script by hand is
// gone from the CLI (Session.ts:6078 is its one `extNotification` call) and the
// adapter's reader for it is retired.
const REPLY_TEXT = "Привет! 👋";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-resume-compress-streaming-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Routes each prompt by its text — "/compress" gets the REAL compress frames
// (ext notifications, no chunks, like qwen 0.13.1), anything else streams a
// normal text reply.
const script = (input: { readonly promptTexts: string[] }): FakeAcpScript => ({
  loadReplayChunks: ["старое сообщение 1", "старое сообщение 2"],
  onPromptText: (text) => input.promptTexts.push(text),
  onPrompt: (steps) => {
    const lastPrompt = input.promptTexts[input.promptTexts.length - 1] ?? "";
    if (lastPrompt.trim() === "/compress") {
      steps
        .emitCompressProgress()
        .emitCompressResult({ preTokens: 15142, postTokens: 4236 })
        .respondOk();
      return;
    }
    steps.emitText(REPLY_TEXT).respondOk();
  },
});

it.effect(
  "resumed session (history replay) + hidden compress → resume again → the NEXT turn still streams its reply",
  () =>
    Effect.gen(function* () {
      const promptTexts: string[] = [];
      const collected: ProviderRuntimeEvent[] = [];
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const eventsFiber = yield* Effect.forkChild(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              collected.push(event);
            }),
          ),
        );
        const threadId = ThreadId.make("resume-compress-streaming");
        const resumeCursor = { schemaVersion: 1, sessionId: FAKE_SESSION_ID } as const;

        // Live sequence: reload → open old thread → the resume happens on the
        // first action (a valid cursor takes session/load; replay rides it).
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor,
        });
        // Meter button / the composer's /compress — both are compactContext.
        // ru-code (qwen-compression wave): the compaction keeps the session, so
        // there is no second resume; the next turn rides the SAME child.
        yield* adapter.compactContext!(threadId).pipe(Effect.timeout("10 seconds"));
        assert.isTrue(yield* adapter.hasSession(threadId), "compaction keeps the session");

        const turn = yield* adapter
          .sendTurn({ threadId, input: "привет", runtimeMode: "approval-required" })
          .pipe(Effect.timeout("10 seconds"));
        // The trailing assistant item completion is enqueued AFTER the prompt
        // resolves — wait for it before freezing the collected set.
        yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const done = collected.some(
              (event) =>
                event.type === "item.completed" &&
                "payload" in event &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "itemType" in event.payload &&
                event.payload.itemType === "assistant_message",
            );
            if (done) return;
            yield* Effect.sleep("10 millis");
          }
          return yield* Effect.die(new Error("assistant item completion never arrived"));
        });
        yield* Fiber.interrupt(eventsFiber);

        // The prompts in order: the hidden compression, then the turn.
        assert.deepStrictEqual(promptTexts, ["/compress", "привет"]);

        // Replay chunks from the session/load window must NOT surface.
        const deltas = collected.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        );
        assert.isUndefined(
          deltas.find((event) => event.payload.delta.includes("старое сообщение")),
          "history replay must stay suppressed",
        );

        // THE report: the post-compress turn's reply must stream through.
        const replyDeltas = deltas.filter((event) => event.payload.delta.includes(REPLY_TEXT));
        assert.isAtLeast(replyDeltas.length, 1, "the turn's reply delta must be emitted");
        assert.strictEqual(replyDeltas[0]!.turnId, turn.turnId, "delta must carry the turn");

        // And its assistant item lifecycle must be present and turn-bound.
        const itemEvents = collected.filter(
          (event) =>
            (event.type === "item.started" || event.type === "item.completed") &&
            "payload" in event &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            "itemType" in event.payload &&
            event.payload.itemType === "assistant_message",
        );
        assert.isAtLeast(itemEvents.length, 2, "assistant item started+completed expected");
        for (const event of itemEvents) {
          assert.strictEqual(event.turnId, turn.turnId, `item ${event.type} lost its turn`);
        }

        // The turn itself settled as a normal completion.
        const turnCompleted = collected.find(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        assert.isDefined(turnCompleted, "turn.completed must be emitted");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.provideMerge(fakeAcpSpawnerLayer(script({ promptTexts })), testServices),
        ),
      );
    }).pipe(TestClock.withLive),
);
