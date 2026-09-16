// ru-code (qwen-compression wave): THE POST-COMPACTION SESSION CONTRACT, and it
// is now "nothing is retired".
//
// The suite used to assert the opposite, and was right about qwen 0.13.1: that
// ACP session captured its chat object once (acpAgent.ts:487) while
// `tryCompressChat` replaced `client.chat` underneath it (client.ts:236), so a
// live session kept sending the FULL pre-compress history after a `/compress`
// (the meter dropped; the request did not). The fix was to retire the session
// and let the next action resume it via `session/load`, rebuilding the chat from
// the recorded compressed history.
//
// qwen 0.21.1 does not do that capture. `GeminiChat.tryCompress` mutates the
// live chat in place (geminiChat.ts:1843-1847), `GeminiClient.tryCompressChat`
// rebuilds the chat object from the compressed history (client.ts:3301-3305),
// and the ACP session caches NO chat — `#getCurrentChat()` re-reads
// `getGeminiClient().getChat()` on every send (Session.ts:4276-4278) and
// `#syncPromptTokenCountWithCurrentChat` explicitly detects the swap
// (Session.ts:4613-4622). So the very next `session/prompt` on the SAME session
// already carries the compressed history, and the teardown bought a
// `session/load` round-trip and a fresh spawn for nothing.
//
// What this suite pins now: a CONFIRMED compression keeps the session, its child
// and its sessionId, and the next turn answers over them; an UNCONFIRMED one and
// a FAILED compress prompt do the same (they always did).
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
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { pollForSpawns } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
// ru-code (qwen-compression wave): the compress steps below speak qwen 0.21.1's
// ONLY channel — `session/update` `agent_message_chunk` +
// `_meta.source:"slash_command"` (MessageEmitter.ts:152-165). The vendor
// notification `_qwencode/slash_command` this suite used to script by hand is
// gone from the CLI (Session.ts:6078 is its one `extNotification` call) and the
// adapter's reader for it is retired.
const REPLY_TEXT = "Привет! 👋";
// ru-code (warm engine v2.1): the pool no longer spawns inline — this suite
// keeps its original counts by asking for the full eager boot budget and a tiny
// chain gap, and reaching each count through a bounded wait.
const POOL_OPTIONS = { eagerOnExpired: 2, refillDelayMs: 50 } as const;

const testServices = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

/** Poll `collected` until a reply delta for `turnId` shows up (or die). */
const awaitReplyDelta = (collected: ProviderRuntimeEvent[], turnId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (
        collected.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.delta.includes(REPLY_TEXT) &&
            event.turnId === turnId,
        )
      ) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error(`reply delta for turn ${turnId} never arrived`));
  });

it.effect("a CONFIRMED compression keeps the session; the next turn answers over it", () =>
  Effect.gen(function* () {
    const promptTexts: string[] = [];
    const collected: ProviderRuntimeEvent[] = [];
    const loadedSessionIds: string[] = [];
    let spawns = 0;
    let kills = 0;
    const script: FakeAcpScript = {
      onPromptText: (text) => promptTexts.push(text),
      onLoadSession: (sessionId) => loadedSessionIds.push(sessionId),
      onPrompt: (steps) => {
        const lastPrompt = promptTexts[promptTexts.length - 1] ?? "";
        if (lastPrompt.trim() === "/compress") {
          steps
            .emitCompressProgress()
            .emitCompressResult({ preTokens: 15142, postTokens: 4236 })
            .respondOk();
          return;
        }
        steps.emitText(REPLY_TEXT).respondOk();
      },
    };
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        poolOptions: POOL_OPTIONS,
      });
      const eventsFiber = yield* Effect.forkChild(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collected.push(event);
          }),
        ),
      );
      const threadId = ThreadId.make("compaction-retires-session");

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "привет", runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      yield* awaitReplyDelta(collected, firstTurn.turnId);

      yield* adapter.compactContext!(threadId).pipe(Effect.timeout("10 seconds"));

      // THE contract: the confirmed compression changed NOTHING about the
      // session. Same registry entry, same child, no exit event — because qwen
      // already swapped the compressed chat into the live session.
      assert.isTrue(
        yield* adapter.hasSession(threadId),
        "session must survive a confirmed compaction",
      );
      assert.strictEqual(kills, 0, "no child may be killed for a compaction");
      assert.isUndefined(
        collected.find((event) => event.type === "session.exited"),
        "no session.exited for a compaction",
      );
      // The compaction row settled as a success.
      const compactionRow = collected.find(
        (event) =>
          event.type === "task.completed" &&
          "payload" in event &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "status" in event.payload &&
          event.payload.status === "completed",
      );
      assert.isDefined(compactionRow, "the compaction task row must complete");

      // And the next turn goes straight out over the SAME session: no
      // `session/load`, no second bind, no new session child.
      const secondTurn = yield* adapter
        .sendTurn({ threadId, input: "снова привет", runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      yield* awaitReplyDelta(collected, secondTurn.turnId);
      assert.deepStrictEqual(
        loadedSessionIds,
        [],
        "nothing may be re-loaded: the compaction never retired the session",
      );
      // ru-code (warm engine v2.1): 2 boot spares + one CHAINED refill after the
      // single bind. Was 4 while the retire forced a second bind.
      yield* pollForSpawns(() => spawns, 3, "2 boot spares + the chained refill");
      assert.strictEqual(spawns, 3, "2 boot spares + 1 refill; ONE session child");

      assert.deepStrictEqual(promptTexts, ["привет", "/compress", "снова привет"]);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script, {
            onSpawn: () => {
              spawns += 1;
            },
            onKill: () => {
              kills += 1;
            },
          }),
          testServices("ru-code-compaction-retires-session-"),
        ),
      ),
    );
  }).pipe(TestClock.withLive),
);

// The keep-alive matrix: neither an UNCONFIRMED compression (prompt ok, no
// "Context compressed" confirmation) nor a FAILED compress prompt (JSON-RPC
// error) recorded anything — the session must survive and keep streaming.
for (const shape of [
  {
    label: "an UNCONFIRMED compression keeps the session alive",
    compressSteps: (steps: import("./fakeAcpCore.ts").PromptSteps) => steps.respondOk(),
  },
  {
    label: "a FAILED compress prompt keeps the session alive",
    // ru-code (qwen-compression wave): the real sequence — the progress frame
    // goes out, then the prompt is rejected (binary-verified,
    // @ru-code/qwen-real-harness `compress-failure`).
    compressSteps: (steps: import("./fakeAcpCore.ts").PromptSteps) =>
      steps.emitCompressProgress().emitCompressFailure("compress exploded (fake)"),
  },
] as const) {
  it.effect(shape.label, () =>
    Effect.gen(function* () {
      const promptTexts: string[] = [];
      const collected: ProviderRuntimeEvent[] = [];
      let spawns = 0;
      let kills = 0;
      const script: FakeAcpScript = {
        onPromptText: (text) => promptTexts.push(text),
        onPrompt: (steps) => {
          const lastPrompt = promptTexts[promptTexts.length - 1] ?? "";
          if (lastPrompt.trim() === "/compress") {
            shape.compressSteps(steps);
            return;
          }
          steps.emitText(REPLY_TEXT).respondOk();
        },
      };
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
          poolOptions: POOL_OPTIONS,
        });
        const eventsFiber = yield* Effect.forkChild(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              collected.push(event);
            }),
          ),
        );
        const threadId = ThreadId.make("compaction-keeps-session");

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        // compactContext never throws once its row is out — the failure is the
        // row's payload; the call itself completes.
        yield* adapter.compactContext!(threadId).pipe(Effect.timeout("10 seconds"));

        assert.isTrue(yield* adapter.hasSession(threadId), "session must survive");
        assert.strictEqual(kills, 0, "no teardown for a non-compression");
        assert.isUndefined(
          collected.find((event) => event.type === "session.exited"),
          "no session.exited",
        );

        const turn = yield* adapter
          .sendTurn({ threadId, input: "привет", runtimeMode: "approval-required" })
          .pipe(Effect.timeout("10 seconds"));
        yield* awaitReplyDelta(collected, turn.turnId);
        // ru-code (warm engine v2.1): was 1 pre-pool — 2 boot spares + one
        // CHAINED refill after the bind; the follow-up turn still rides the
        // SAME session child (no session.exited above proves it).
        yield* pollForSpawns(() => spawns, 3, "2 boot spares + the chained refill");
        assert.strictEqual(spawns, 3, "2 boot spares + 1 refill; one session child");
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.provideMerge(
            fakeAcpSpawnerLayer(script, {
              onSpawn: () => {
                spawns += 1;
              },
              onKill: () => {
                kills += 1;
              },
            }),
            testServices("ru-code-compaction-keeps-session-"),
          ),
        ),
      );
    }).pipe(TestClock.withLive),
  );
}
