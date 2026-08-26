// ru-code (mid-turn wave, P3b): the `delivery_state` SQL column round-trips.
//
// This is where "a page reload renders the right mark" is actually decidable.
// A reload has no client memory and no live event stream — it re-reads the
// projection from disk. If the mark is not in these rows it cannot survive a
// refresh, whatever the live UI does. So the reload requirement is pinned here,
// against real SQL, rather than against a mocked store.
//
// Modelled on `ProjectionThreadsChatViewMode.test.ts`, the fork's existing test
// for the fork's existing nullable column — same shape, same reason: the null
// path is covered by every other fixture, so only an explicit non-null
// round-trip catches a broken column binding.
//
// Covers fork migration 004 (the column) and the marked seams in
// `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`.
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSweepThreadStateReader } from "../../startup/qwenBootSweep.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const THREAD_ID = ThreadId.make("thread-delivery-state-sql");
const NOW = "2026-06-01T00:00:00.000Z";
const TEXT = "typed while the turn was running";

// One id PER SPEC. `it.layer` shares a single in-memory database across the
// block, so a shared id would let one spec's mark leak into the next — which is
// exactly how the first draft of V5 failed: it read V4's surviving «pending»
// (correct preserve behaviour, pinned by V6) and mistook it for its own row.
const messageIdFor = (spec: string) => MessageId.make(`message-delivery-state-${spec}`);

const messageRow = (
  messageId: MessageId,
  overrides: {
    readonly deliveryState?: "pending" | "delivered" | "not-delivered";
    readonly text?: string;
    readonly updatedAt?: string;
  } = {},
) => ({
  messageId,
  threadId: THREAD_ID,
  turnId: TurnId.make("turn-delivery-state-sql"),
  role: "user" as const,
  text: overrides.text ?? TEXT,
  isStreaming: false,
  createdAt: NOW,
  updatedAt: overrides.updatedAt ?? NOW,
  ...(overrides.deliveryState !== undefined ? { deliveryState: overrides.deliveryState } : {}),
});

layer("projection_thread_messages.delivery_state round-trip", (it) => {
  it.effect("V1: persists «pending» and reads it back", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v1");
      yield* repository.upsert(messageRow(messageId, { deliveryState: "pending" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "pending");
      assert.strictEqual(stored.value.text, TEXT);
    }),
  );

  it.effect("V2: a later «delivered» replaces «pending»", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v2");
      yield* repository.upsert(messageRow(messageId, { deliveryState: "pending" }));
      yield* repository.upsert(
        messageRow(messageId, {
          deliveryState: "delivered",
          updatedAt: "2026-06-01T00:00:01.000Z",
        }),
      );

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "delivered");
    }),
  );

  it.effect("V3: «not-delivered» round-trips too", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v3");
      yield* repository.upsert(messageRow(messageId, { deliveryState: "not-delivered" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "not-delivered");
    }),
  );

  it.effect("V4 (RELOAD): the list read — the one a refresh uses — carries the mark", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v4");
      yield* repository.upsert(messageRow(messageId, { deliveryState: "pending" }));

      // `listByThreadId` is the read a freshly-loaded thread performs. Marks
      // that exist only on the single-row path would vanish on refresh.
      const listed = yield* repository.listByThreadId({ threadId: THREAD_ID });
      const row = listed.find((candidate) => candidate.messageId === messageId);
      assert.isDefined(row);
      assert.strictEqual(row?.deliveryState, "pending");
    }),
  );

  it.effect("V5 (CONTROL): an ordinary message has NO mark — absent, not a fourth state", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v5");
      yield* repository.upsert(messageRow(messageId));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      // NULL in SQL maps to an ABSENT field, so every pre-existing row keeps
      // its exact meaning and no balloon acquires a mark it never had.
      assert.isUndefined(stored.value.deliveryState);
    }),
  );

  it.effect("V6: a mark-only re-write (no deliveryState carried) PRESERVES the stored mark", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = messageIdFor("v6");
      yield* repository.upsert(messageRow(messageId, { deliveryState: "delivered" }));
      // The assistant-style re-emission path carries no deliveryState. Without
      // the COALESCE seam this would silently erase the mark.
      yield* repository.upsert(messageRow(messageId, { updatedAt: "2026-06-01T00:00:02.000Z" }));

      const stored = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.strictEqual(stored.value.deliveryState, "delivered");
    }),
  );
});

// ── FR6 — WHICH rows the boot sweep considers stale ──────────────────────────
//
// Round 2's residual on M3: the sweep's DISPATCH half is pinned (a stub reader
// feeds ids in), but the SQL predicate that decides which rows are stale is not.
// Mutating the `WHERE` to `delivery_state = 'delivered'` left every spec green,
// so the sweep could have terminalised exactly the wrong messages.
layer("boot sweep — the stale-pending predicate", (it) => {
  it.effect("selects ONLY rows marked pending, not delivered / not-delivered / unmarked", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.upsert(
        messageRow(messageIdFor("sweep-pending"), { deliveryState: "pending" }),
      );
      yield* repository.upsert(
        messageRow(messageIdFor("sweep-delivered"), { deliveryState: "delivered" }),
      );
      yield* repository.upsert(
        messageRow(messageIdFor("sweep-notdelivered"), { deliveryState: "not-delivered" }),
      );
      // An ordinary message: no mark at all, the overwhelmingly common case.
      yield* repository.upsert(messageRow(messageIdFor("sweep-plain")));

      const reader = makeSweepThreadStateReader(sql, () =>
        Effect.succeed(Option.some({ session: null } as never)),
      );
      const state = yield* reader(THREAD_ID).pipe(Effect.orDie);

      assert.isNotNull(state);
      assert.deepStrictEqual(
        [...(state?.pendingDeliveryMessageIds ?? [])],
        [messageIdFor("sweep-pending")],
        "only a PENDING mark is stale — a delivered or unmarked row must be left alone",
      );
    }),
  );
});
