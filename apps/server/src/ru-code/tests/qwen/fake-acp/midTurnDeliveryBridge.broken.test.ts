// ru-code (mid-turn wave, P3c): THE ADAPTER→COMMAND BRIDGE, born-red.
//
// P3b landed the persisted mark and proved it survives a reload, but nothing
// ever SET one: the adapter had no way to say which message row it had just
// delivered. These specs pin that missing link at the only layer where the
// truth is known — the adapter, which owns the queue and therefore knows the
// exact moment a message was handed to the model.
//
// The claim under test is a TIMING claim, and it is the whole point of the
// feature: a mark flips on ACTUAL HANDOFF (a drain the agent performed, or the
// turn-end flush), never merely on being accepted for sending. A mark that
// flipped at send time would be a lie — it would show a delivered tick for text
// the model never saw, which is worse than showing no mark at all.
//
// Driven over the REAL QwenAdapter + the real effect-acp wire via the same fake
// used by R1-R8, with the drain knob transcribed from qwen 0.21.1.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { type ProviderAdapterError } from "../../../../provider/Errors.ts";
import { type ProviderAdapterShape } from "../../../../provider/Services/ProviderAdapter.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript, type PromptSteps } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { collectAdapterEvents, pollUntil } from "./testKit.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-midturn-p3c-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const RUNNING = "TURN_IS_RUNNING";
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

/** Every delivery-state transition the adapter announced, in order. */
type Mark = { readonly messageId: string; readonly deliveryState: string };

const marksOf = (events: ReadonlyArray<ProviderRuntimeEvent>): ReadonlyArray<Mark> =>
  events.flatMap((event) =>
    event.type === "message.delivery-state"
      ? [
          {
            messageId: event.payload.messageId,
            deliveryState: event.payload.deliveryState,
          },
        ]
      : [],
  );

const makeScript = (options: {
  readonly drain: boolean;
  readonly pauseMs?: number;
}): FakeAcpScript => {
  let promptIndex = 0;
  return {
    ...(options.drain ? { midTurnDrain: {} } : {}),
    onPrompt: (steps: PromptSteps) => {
      const first = promptIndex === 0;
      promptIndex += 1;
      if (!first) {
        steps.emitText("second-turn-reply").respondOk();
        return;
      }
      const chain = steps.emitText(RUNNING).sleep(options.pauseMs ?? 400);
      (options.drain ? chain.drainMidTurn() : chain).respondOk();
    },
  };
};

const withRunningTurn = (
  script: FakeAcpScript,
  threadName: string,
  body: (input: {
    readonly adapter: Adapter;
    readonly threadId: ThreadId;
    readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  }) => Effect.Effect<void, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(threadName);
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const collector = yield* collectAdapterEvents(adapter);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* Effect.forkChild(
        adapter.sendTurn({ threadId, input: "first", runtimeMode: "approval-required" }),
      );
      yield* collector.waitForDelta(RUNNING);
      yield* body({ adapter, threadId, events: collector.events });
      yield* collector.stop;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  });

// ── C1 — the timing claim: queued ≠ delivered ────────────────────────────────

it.effect(
  "midturn C1 (RED): a mid-turn send announces PENDING, never delivered, at send time",
  () =>
    Effect.gen(function* () {
      const script = makeScript({ drain: false, pauseMs: 900 });
      const messageId = MessageId.make("c1-message");
      yield* withRunningTurn(script, "midturn-c1", ({ adapter, threadId, events }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(
            adapter.sendTurn({
              threadId,
              input: "queued text",
              messageId,
              runtimeMode: "approval-required",
            }),
          );
          yield* pollUntil(() => marksOf(events).length >= 1, "the pending mark");
          // Read the marks BEFORE the turn ends, i.e. while the message is still
          // genuinely undelivered. A delivered mark here would be a visible lie.
          assert.deepStrictEqual(marksOf(events), [
            { messageId: "c1-message", deliveryState: "pending" },
          ]);
        }),
      );
    }),
);

// ── C2 — delivered on a REAL drain handoff ───────────────────────────────────

it.effect(
  "midturn C2 (RED): the mark flips to DELIVERED when the drain actually hands it over",
  () =>
    Effect.gen(function* () {
      const script = makeScript({ drain: true });
      const messageId = MessageId.make("c2-message");
      yield* withRunningTurn(script, "midturn-c2", ({ adapter, threadId, events }) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(
            adapter.sendTurn({
              threadId,
              input: "steer me",
              messageId,
              runtimeMode: "approval-required",
            }),
          );
          yield* pollUntil(
            () => marksOf(events).some((mark) => mark.deliveryState === "delivered"),
            "the delivered mark",
          );
          assert.deepStrictEqual(marksOf(events), [
            { messageId: "c2-message", deliveryState: "pending" },
            { messageId: "c2-message", deliveryState: "delivered" },
          ]);
        }),
      );
    }),
);

// ── C3 — delivered on the turn-end flush (the no-polling engine) ─────────────

it.effect("midturn C3 (RED): the turn-end flush also flips the mark to DELIVERED", () =>
  Effect.gen(function* () {
    // Drain OFF = an engine that never polls; the flush is the only route.
    const script = makeScript({ drain: false, pauseMs: 250 });
    const messageId = MessageId.make("c3-message");
    yield* withRunningTurn(script, "midturn-c3", ({ adapter, threadId, events }) =>
      Effect.gen(function* () {
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "flush me",
            messageId,
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(
          () => marksOf(events).some((mark) => mark.deliveryState === "delivered"),
          "the delivered mark from the flush",
        );
        assert.deepStrictEqual(marksOf(events), [
          { messageId: "c3-message", deliveryState: "pending" },
          { messageId: "c3-message", deliveryState: "delivered" },
        ]);
      }),
    );
  }),
);

// ── C4 — NOT-DELIVERED on teardown reset ─────────────────────────────────────

it.effect(
  "midturn C4 (RED): a stop resets the queue and marks the pending message NOT-DELIVERED",
  () =>
    Effect.gen(function* () {
      const script = makeScript({ drain: false, pauseMs: 3_000 });
      const messageId = MessageId.make("c4-message");
      const threadId = ThreadId.make("midturn-c4");
      yield* Effect.gen(function* () {
        const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
        const collector = yield* collectAdapterEvents(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* Effect.forkChild(
          adapter.sendTurn({ threadId, input: "first", runtimeMode: "approval-required" }),
        );
        yield* collector.waitForDelta(RUNNING);
        yield* Effect.forkChild(
          adapter.sendTurn({
            threadId,
            input: "never sent",
            messageId,
            runtimeMode: "approval-required",
          }),
        );
        yield* pollUntil(() => marksOf(collector.events).length >= 1, "the pending mark");

        yield* adapter.stopSession(threadId).pipe(Effect.timeout("10 seconds"));
        yield* pollUntil(
          () => marksOf(collector.events).some((mark) => mark.deliveryState === "not-delivered"),
          "the not-delivered mark",
        );

        assert.deepStrictEqual(marksOf(collector.events), [
          { messageId: "c4-message", deliveryState: "pending" },
          { messageId: "c4-message", deliveryState: "not-delivered" },
        ]);
        yield* collector.stop;
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
        TestClock.withLive,
      );
    }),
);

// ── C5 — a batch flips together, and each message keeps its own identity ─────

it.effect(
  "midturn C5 (RED): several queued messages each get their own mark, flipped together",
  () =>
    Effect.gen(function* () {
      const script = makeScript({ drain: true });
      yield* withRunningTurn(script, "midturn-c5", ({ adapter, threadId, events }) =>
        Effect.gen(function* () {
          for (const index of [0, 1, 2]) {
            yield* Effect.forkChild(
              adapter.sendTurn({
                threadId,
                input: `msg-${index}`,
                messageId: MessageId.make(`c5-message-${index}`),
                runtimeMode: "approval-required",
              }),
            );
            // Ordered sends: the marks must stay addressable per message, and a
            // batch drain must not collapse them into one.
            yield* pollUntil(() => marksOf(events).length >= index + 1, `pending ${index}`);
          }
          yield* pollUntil(
            () => marksOf(events).filter((mark) => mark.deliveryState === "delivered").length === 3,
            "three delivered marks",
          );

          const delivered = marksOf(events)
            .filter((mark) => mark.deliveryState === "delivered")
            .map((mark) => mark.messageId);
          assert.deepStrictEqual(delivered, ["c5-message-0", "c5-message-1", "c5-message-2"]);
        }),
      );
    }),
);
