// ru-code: the post-compaction session-retirement contract. qwen 0.13.1's ACP
// session captures its chat object once (acpAgent.ts:487) while tryCompressChat
// replaces `client.chat` underneath it (client.ts:236) — a live session keeps
// sending the FULL pre-compress history to the model after a `/compress` (the
// meter drops; the request does not). The compression IS recorded to the
// session file, so the fix is: a CONFIRMED compression retires the session
// (COMPACTION_RESTART_METHOD), and the next action resumes via `session/load`
// with the SAME sessionId — rebuilding the chat from the compressed history.
// Unconfirmed or failed compressions must NOT retire the session: nothing was
// recorded, a restart would only lose the live process for no gain.
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
const COMPRESS_METHOD = "_qwencode/slash_command";
const REPLY_TEXT = "Привет! 👋";

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

it.effect("a CONFIRMED compression retires the session; the next start resumes it compressed", () =>
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
            .emitExtNotification(COMPRESS_METHOD, {
              message: "Compressing context...",
              messageType: "info",
            })
            .emitExtNotification(COMPRESS_METHOD, {
              message: "Context compressed (15142 -> 4236).",
              messageType: "info",
            })
            .respondOk();
          return;
        }
        steps.emitText(REPLY_TEXT).respondOk();
      },
    };
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
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

      // THE contract: the confirmed compression ended the session (force-kill +
      // session.exited) — qwen's stale in-memory chat is gone with it.
      assert.isFalse(yield* adapter.hasSession(threadId), "session must be retired");
      assert.strictEqual(kills, 1, "the stale child must be force-killed");
      assert.isDefined(
        collected.find((event) => event.type === "session.exited"),
        "session.exited must be emitted",
      );
      // The compaction row still settled as a success.
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

      // The next action (live: ProviderService's allowRecovery on the next
      // turn) resumes the SAME sessionId over session/load — the path that
      // rebuilds the chat from the RECORDED (compressed) history.
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
      });
      assert.deepStrictEqual(
        loadedSessionIds,
        [FAKE_SESSION_ID],
        "the restart must take session/load with the same sessionId",
      );
      assert.strictEqual(spawns, 2, "the resume runs on a fresh child");

      const secondTurn = yield* adapter
        .sendTurn({ threadId, input: "снова привет", runtimeMode: "approval-required" })
        .pipe(Effect.timeout("10 seconds"));
      yield* awaitReplyDelta(collected, secondTurn.turnId);

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
    compressSteps: (steps: import("./fakeAcpCore.ts").PromptSteps) =>
      steps.respondError(-32603, "compress exploded (fake)"),
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
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
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
        assert.strictEqual(spawns, 1, "same child serves the follow-up turn");
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
