// ru-code: law tests for the per-stream catch-up read (boot-performance.md S1).
//
// `readStreamFromSequence` exists so a thread catch-up reads ONLY its own stream
// (index-served) instead of the whole global tail. Its contract is equivalence:
// for any cursor and limit, it returns exactly what `readFromSequence` +
// client-side stream filtering would have returned — nothing more, nothing less,
// same order.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../../persistence/Services/OrchestrationEventStore.ts";

// One in-memory store is shared across the block (it.layer), so every test seeds
// under its own prefix to keep event ids and streams disjoint.
const threadA = (prefix: string) => ThreadId.make(`${prefix}-thread-a`);
const threadB = (prefix: string) => ThreadId.make(`${prefix}-thread-b`);
const projectId = (prefix: string) => ProjectId.make(`${prefix}-project`);

const eventStoreLayer = it.layer(
  OrchestrationEventStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const messageSent = (threadId: ThreadId, index: number): Omit<OrchestrationEvent, "sequence"> => ({
  eventId: EventId.make(`event-${threadId}-${index}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make(`command-${threadId}-${index}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(`message-${threadId}-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index}`,
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const projectCreated = (prefix: string, index: number): Omit<OrchestrationEvent, "sequence"> => ({
  eventId: EventId.make(`event-${prefix}-project-${index}`),
  aggregateKind: "project",
  aggregateId: projectId(prefix),
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make(`command-project-${index}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.meta-updated",
  payload: {
    projectId: projectId(prefix),
    title: `Project ${index}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

/** Interleave three streams so per-stream reads must skip foreign rows. */
const seedInterleaved = Effect.fnUntraced(function* (prefix: string) {
  const store = yield* OrchestrationEventStore;
  for (let index = 0; index < 12; index++) {
    yield* store.append(messageSent(threadA(prefix), index));
    yield* store.append(messageSent(threadB(prefix), index));
    if (index % 3 === 0) {
      yield* store.append(projectCreated(prefix, index));
    }
  }
});

eventStoreLayer("readStreamFromSequence (S1 catch-up read)", (it) => {
  it.effect("law: equals readFromSequence + stream filter, for every cursor", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      yield* seedInterleaved("law");

      const everything = yield* store
        .readFromSequence(0, Number.MAX_SAFE_INTEGER)
        .pipe(Stream.runCollect);
      assert.equal(everything.filter((event) => String(event.eventId).includes("law")).length, 28);

      for (const cursor of [0, 1, 5, 13, 27, 28]) {
        const filtered = everything.filter(
          (event) =>
            event.sequence > cursor &&
            event.aggregateKind === "thread" &&
            event.aggregateId === threadA("law"),
        );
        const streamed = yield* store
          .readStreamFromSequence("thread", threadA("law"), cursor, Number.MAX_SAFE_INTEGER)
          .pipe(Stream.runCollect);
        assert.deepEqual([...streamed], filtered, `cursor ${cursor}`);
      }
    }),
  );

  it.effect("respects the limit and pages in order", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      yield* seedInterleaved("limit");

      const firstFive = yield* store
        .readStreamFromSequence("thread", threadB("limit"), 0, 5)
        .pipe(Stream.runCollect);
      assert.equal(firstFive.length, 5);
      const sequences = firstFive.map((event) => event.sequence);
      assert.deepEqual(
        [...sequences].sort((a, b) => a - b),
        sequences,
      );
      for (const event of firstFive) {
        assert.equal(event.aggregateId, threadB("limit"));
      }

      const none = yield* store
        .readStreamFromSequence("thread", threadB("limit"), 0, 0)
        .pipe(Stream.runCollect);
      assert.equal(none.length, 0);
    }),
  );

  it.effect("an unknown stream reads empty without touching foreign rows", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      yield* seedInterleaved("missing");
      const missing = yield* store
        .readStreamFromSequence("thread", ThreadId.make("thread-missing"), 0, 100)
        .pipe(Stream.runCollect);
      assert.equal(missing.length, 0);
    }),
  );
});

// Fresh block ⇒ fresh in-memory DB: the empty-store case needs zero rows.
eventStoreLayer("readLatestSequence (S1 gap cursor)", (it) => {
  it.effect("an empty store reads 0; after appends it reads the store tail", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      assert.equal(yield* store.readLatestSequence(), 0);

      yield* seedInterleaved("latest");
      const everything = yield* store
        .readFromSequence(0, Number.MAX_SAFE_INTEGER)
        .pipe(Stream.runCollect);
      const maxSequence = Math.max(...everything.map((event) => event.sequence));
      assert.equal(yield* store.readLatestSequence(), maxSequence);
    }),
  );
});
