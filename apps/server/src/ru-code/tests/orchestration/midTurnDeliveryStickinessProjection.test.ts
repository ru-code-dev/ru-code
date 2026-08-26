// ru-code (mid-turn wave, phase 4b — m4/SB4, MUT-8): stickiness AT THE
// PROJECTION, which is the copy a page reload reads.
//
// Round 2 proved this was the serious gap: `mergeMidTurnDeliveryState` is
// correctly implemented AND correctly called, but **removing the call in
// `ProjectionPipeline` was invisible to the entire suite** (MUT-8 green
// everywhere). The six contracts-level specs import the function and call it
// directly, so they pin the RULE and not the WIRING.
//
// The audit also refuted the comfortable assumption that SQL covers this:
// `COALESCE(excluded.delivery_state, stored)` returns `incoming` whenever
// incoming is non-NULL — that is last-writer-wins. It implements
// "absent-doesn't-erase" and CANNOT implement "terminal marks are sticky",
// because a `not-delivered` arriving after a `delivered` is non-NULL and wins.
// So the in-memory merge is the SOLE enforcement on the reload-surviving copy,
// and deleting it is a silent correctness regression rather than a cleanup.
//
// Driven through the real pipeline in memory — no engine, no reactor.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../../config.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";

// ONE SqlitePersistenceMemory for both the pipeline and the repository — two
// `provideMerge`s of it would build two separate in-memory databases and the
// read would query an empty one.
const layer = it.layer(
  Layer.mergeAll(OrchestrationProjectionPipelineLive, ProjectionThreadMessageRepositoryLive).pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-sticky-proj-" })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const THREAD_ID = ThreadId.make("sticky-projection-thread");
const NOW = "2026-07-01T00:00:00.000Z";

let sequence = 0;
const messageSent = (input: {
  readonly messageId: MessageId;
  readonly text: string;
  readonly deliveryState?: "pending" | "delivered" | "not-delivered";
}): OrchestrationEvent => {
  sequence += 1;
  const id = `sticky-evt-${sequence}`;
  return {
    type: "thread.message-sent",
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(id),
    causationEventId: null,
    correlationId: CorrelationId.make(id),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      messageId: input.messageId,
      role: "user",
      text: input.text,
      turnId: null,
      streaming: false,
      ...(input.deliveryState !== undefined ? { deliveryState: input.deliveryState } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationEvent;
};

layer("delivery-state stickiness through the projection", (it) => {
  it.effect("a not-delivered AFTER a delivered leaves the row DELIVERED", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* pipeline.bootstrap;
      const eventStore = yield* OrchestrationEventStore;
      const repository = yield* ProjectionThreadMessageRepository;
      // APPEND then project: the pipeline needs the store-assigned sequence, so
      // a hand-built event cannot be projected directly (same shape the port
      // test uses).
      const project = (event: OrchestrationEvent) =>
        eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
      const messageId = MessageId.make("sticky-proj-1");

      yield* project(messageSent({ messageId, text: "hello", deliveryState: "pending" }));
      yield* project(messageSent({ messageId, text: "", deliveryState: "delivered" }));
      // The dangerous ordering. Last-writer-wins — which is what SQL does on its
      // own — would flip this row and a refresh would render the lie.
      yield* project(messageSent({ messageId, text: "", deliveryState: "not-delivered" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(
        stored.value.deliveryState,
        "delivered",
        "a message the model already saw must never be un-delivered",
      );
      assert.strictEqual(stored.value.text, "hello", "the mark must not rewrite the text");
    }),
  );

  it.effect("a delivered AFTER a not-delivered leaves the row NOT-DELIVERED", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* pipeline.bootstrap;
      const eventStore = yield* OrchestrationEventStore;
      const repository = yield* ProjectionThreadMessageRepository;
      // APPEND then project: the pipeline needs the store-assigned sequence, so
      // a hand-built event cannot be projected directly (same shape the port
      // test uses).
      const project = (event: OrchestrationEvent) =>
        eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
      const messageId = MessageId.make("sticky-proj-2");

      yield* project(messageSent({ messageId, text: "hi", deliveryState: "pending" }));
      yield* project(messageSent({ messageId, text: "", deliveryState: "not-delivered" }));
      // Nothing auto-fires after a stop: a stray late drain must not resurrect
      // a message the user was already told had failed.
      yield* project(messageSent({ messageId, text: "", deliveryState: "delivered" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "not-delivered");
    }),
  );

  it.effect("pending still moves — it is the only movable state", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* pipeline.bootstrap;
      const eventStore = yield* OrchestrationEventStore;
      const repository = yield* ProjectionThreadMessageRepository;
      // APPEND then project: the pipeline needs the store-assigned sequence, so
      // a hand-built event cannot be projected directly (same shape the port
      // test uses).
      const project = (event: OrchestrationEvent) =>
        eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
      const messageId = MessageId.make("sticky-proj-3");

      yield* project(messageSent({ messageId, text: "yo", deliveryState: "pending" }));
      yield* project(messageSent({ messageId, text: "", deliveryState: "delivered" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "delivered");
    }),
  );
});
