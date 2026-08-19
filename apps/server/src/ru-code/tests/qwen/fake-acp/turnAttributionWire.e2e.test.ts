// ru-code: turn-attribution WIRE proof for the diff-chip disease. Drives the
// REAL QwenAdapter over the in-memory fake ACP agent, which reproduces the two
// behaviours of real qwen 0.13.1 that caused it:
//   - qwen offers NO identity on the wire (agent_message_chunk carries no
//     item/turn ids), so the runtime minting items + the adapter stamping
//     turnId is the ONLY source of turn attribution downstream;
//   - the runtime's trailing AssistantItemCompleted is enqueued AFTER
//     session/prompt resolves, and qwen's chunk emission is un-awaited
//     (qwen-code Session.ts:308), so item events can be consumed after the
//     turn finalizer cleared `activeTurnId`.
// The old stamping read `ctx.activeTurnId` at consumption time → the trailing
// completion carried NO turnId → ingestion dispatched a second turn-less
// assistant.complete → projections wiped the message's turnId → diff chip,
// revert and healing all went blind (live log 2026-07-12 12:52).
//
// Pinned here, end to end over the wire:
//   1. single turn — EVERY assistant item event (started / delta / trailing
//      completed) carries THE turn's id;
//   2. a chunk arriving strictly AFTER sendTurn returned (finalizer provably
//      done) still attributes to the turn that just ended, and its completion
//      (flushed by the NEXT turn's pre-prompt close, when `activeTurnId` is
//      already the next turn) keeps the ORIGINAL turn — no null, no
//      cross-turn bleed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_RUNTIME_MODE,
  QwenSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-turn-attribution-wire-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const decodeQwenSettings = Schema.decodeUnknownSync(QwenSettings);

const isAssistantItemEvent = (
  event: ProviderRuntimeEvent,
): event is ProviderRuntimeEvent & { readonly type: "item.started" | "item.completed" } =>
  (event.type === "item.started" || event.type === "item.completed") &&
  "payload" in event &&
  typeof event.payload === "object" &&
  event.payload !== null &&
  "itemType" in event.payload &&
  event.payload.itemType === "assistant_message";

const isAssistantDeltaEvent = (event: ProviderRuntimeEvent) => event.type === "content.delta";

// Poll the live-collected event array until `select` yields a value. Real
// wall-clock (the tests run under TestClock.withLive); bounded so a wiring
// regression fails loudly instead of hanging the suite.
const awaitCollected = <A>(select: () => A | undefined): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const match = select();
      if (match !== undefined) return match;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("expected runtime event was never collected"));
  });

it.effect("single turn: started, delta and the TRAILING completed all carry the turn's id", () =>
  Effect.gen(function* () {
    const collected: Array<ProviderRuntimeEvent> = [];
    const script: FakeAcpScript = {
      onPrompt: (steps) => {
        steps.emitText("ответ").respondOk();
      },
    };
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          collected.push(event);
        }),
      ).pipe(Effect.forkChild);
      const threadId = ThreadId.make("qwen-attribution-single-turn");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "первый вопрос", runtimeMode: DEFAULT_RUNTIME_MODE })
        .pipe(Effect.timeout("10 seconds"));

      // The trailing completion is enqueued after session/prompt resolves —
      // wait for it to be consumed, then hold the WHOLE item event set to the
      // turn id sendTurn reported.
      yield* awaitCollected(() =>
        collected.find((event) => isAssistantItemEvent(event) && event.type === "item.completed"),
      );
      const itemEvents = collected.filter(isAssistantItemEvent);
      const deltaEvents = collected.filter(isAssistantDeltaEvent);
      assert.isAtLeast(itemEvents.length, 2, "expected item.started + trailing item.completed");
      assert.isAtLeast(deltaEvents.length, 1);
      for (const event of [...itemEvents, ...deltaEvents]) {
        assert.strictEqual(
          event.turnId,
          turn.turnId,
          `event ${event.type} must carry the turn id, got ${String(event.turnId)}`,
        );
      }
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    );
  }).pipe(TestClock.withLive),
);

it.effect(
  "chunk AFTER the turn settled: attributed to the ended turn; its completion under the NEXT turn keeps the original turn (no null, no cross-turn bleed)",
  () =>
    Effect.gen(function* () {
      const collected: Array<ProviderRuntimeEvent> = [];
      let outOfBand: { agentMessageChunk: (text: string) => Effect.Effect<void> } | undefined;
      const script: FakeAcpScript = {
        onOutOfBandEmitter: (emit) => {
          outOfBand = emit;
        },
        onPrompt: (steps) => {
          steps.emitText("ответ").respondOk();
        },
      };
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collected.push(event);
          }),
        ).pipe(Effect.forkChild);
        const threadId = ThreadId.make("qwen-attribution-late-chunk");
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });

        const firstTurn = yield* adapter
          .sendTurn({ threadId, input: "первый вопрос", runtimeMode: DEFAULT_RUNTIME_MODE })
          .pipe(Effect.timeout("10 seconds"));
        // sendTurn resolves after its finalizer ran — `activeTurnId` is
        // provably cleared. Wait for the first item's trailing completion so
        // the first segment is closed before the late chunk arrives.
        yield* awaitCollected(() =>
          collected.find((event) => isAssistantItemEvent(event) && event.type === "item.completed"),
        );

        // Real-qwen behaviour: an un-awaited chunk lands AFTER the prompt
        // response. It must open a NEW item attributed to the turn that just
        // ended — not to "no turn".
        const lateEmitter = outOfBand;
        if (lateEmitter === undefined) {
          return yield* Effect.die(new Error("fake agent must expose the out-of-band emitter"));
        }
        yield* lateEmitter.agentMessageChunk("поздний хвост");
        const lateStarted = yield* awaitCollected(() => {
          const startedEvents = collected.filter(
            (event) => isAssistantItemEvent(event) && event.type === "item.started",
          );
          return startedEvents.length >= 2 ? startedEvents[1] : undefined;
        });
        assert.strictEqual(
          lateStarted.turnId,
          firstTurn.turnId,
          "late item must attribute to the turn that just ended",
        );
        const lateItemId = "itemId" in lateStarted ? lateStarted.itemId : undefined;
        assert.isDefined(lateItemId);
        const lateDelta = yield* awaitCollected(() =>
          collected.find(
            (event) =>
              isAssistantDeltaEvent(event) && "itemId" in event && event.itemId === lateItemId,
          ),
        );
        assert.strictEqual(lateDelta.turnId, firstTurn.turnId);

        // The NEXT turn's pre-prompt close flushes the late item while
        // `activeTurnId` is already the next turn — the pin recorded at the
        // item's start must win (the old code would stamp the NEW turn here,
        // bleeding the tail across turns; before the clear-fix it stamped
        // nothing at all).
        const secondTurn = yield* adapter
          .sendTurn({ threadId, input: "второй вопрос", runtimeMode: DEFAULT_RUNTIME_MODE })
          .pipe(Effect.timeout("10 seconds"));
        const lateCompleted = yield* awaitCollected(() =>
          collected.find(
            (event) =>
              isAssistantItemEvent(event) &&
              event.type === "item.completed" &&
              "itemId" in event &&
              event.itemId === lateItemId,
          ),
        );
        assert.strictEqual(
          lateCompleted.turnId,
          firstTurn.turnId,
          "late item completion must keep the ORIGINAL turn",
        );

        // And the second turn's own item events carry the second turn's id.
        const secondTurnItemEvents = collected.filter(
          (event) =>
            isAssistantItemEvent(event) && "itemId" in event && event.itemId !== lateItemId,
        );
        const secondTurnOwn = secondTurnItemEvents.filter(
          (event) => event.turnId === secondTurn.turnId,
        );
        assert.isAtLeast(
          secondTurnOwn.length,
          1,
          "the second turn must produce item events under its own id",
        );
        // No assistant item event anywhere may be turn-less.
        for (const event of collected.filter(isAssistantItemEvent)) {
          assert.isDefined(event.turnId, `item event ${event.type} lost its turn`);
        }
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      );
    }).pipe(TestClock.withLive),
);
