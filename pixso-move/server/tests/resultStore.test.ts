import { DesignerId, ResultTag } from "@pixso-move/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../src/persistence/sqlite.ts";
import { NodeStore } from "../src/services/nodeStore.ts";
import { NodeStoreLive } from "../src/services/nodeStoreLive.ts";
import { ResultStore } from "../src/services/resultStore.ts";
import { ResultStoreLive } from "../src/services/resultStoreLive.ts";

const layer = Layer.mergeAll(NodeStoreLive, ResultStoreLive).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const alice = DesignerId.make("dz_alice");
const react = ResultTag.make("react");
const summary = ResultTag.make("summary");
const seed = { rootName: "Card", nodesJson: "{}", preview: "iVBOR" };

const seedNode = Effect.gen(function* () {
  const nodes = yield* NodeStore;
  const { nodeId } = yield* nodes.insert({ designerId: alice, ...seed });
  return nodeId;
});

it.effect("reconcile inserts missing pairs and is idempotent", () =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const nodeId = yield* seedNode;
    const rows = [
      { designerId: alice, nodeId, resultTag: react },
      { designerId: alice, nodeId, resultTag: summary },
    ];
    assert.equal(yield* store.reconcile(rows), 2);
    assert.equal(yield* store.reconcile(rows), 0);
    assert.equal(yield* store.countPending, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("claimNextPending atomically takes one job; loser gets undefined", () =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const nodeId = yield* seedNode;
    yield* store.reconcile([{ designerId: alice, nodeId, resultTag: react }]);
    const job = yield* store.claimNextPending;
    assert.isDefined(job);
    assert.equal(job?.resultTag, react);
    assert.equal(yield* store.countPending, 0);
    assert.isUndefined(yield* store.claimNextPending);
  }).pipe(Effect.provide(layer)),
);

it.effect("complete and fail set terminal status and listByNode reflects it", () =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const nodeId = yield* seedNode;
    yield* store.reconcile([
      { designerId: alice, nodeId, resultTag: react },
      { designerId: alice, nodeId, resultTag: summary },
    ]);
    const first = yield* store.claimNextPending;
    const second = yield* store.claimNextPending;
    yield* store.complete(first?.id ?? "", "generated code");
    yield* store.fail(second?.id ?? "", "boom");
    const results = yield* store.listByNode(alice, nodeId);
    assert.equal(results.length, 2);
    const done = results.find((r) => r.status === "done");
    const errored = results.find((r) => r.status === "error");
    assert.equal(done?.result, "generated code");
    assert.equal(errored?.error, "boom");
    assert.isString(done?.finishedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("recoverInFlight flips processing back to pending without bumping attempts", () =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const nodeId = yield* seedNode;
    yield* store.reconcile([{ designerId: alice, nodeId, resultTag: react }]);
    yield* store.claimNextPending; // → processing, attempts = 1
    assert.equal(yield* store.recoverInFlight, 1);
    const [row] = yield* store.listByNode(alice, nodeId);
    assert.equal(row?.status, "pending");
    assert.equal(row?.attempts, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("listByNode is scoped by designer", () =>
  Effect.gen(function* () {
    const store = yield* ResultStore;
    const nodeId = yield* seedNode;
    yield* store.reconcile([{ designerId: alice, nodeId, resultTag: react }]);
    assert.equal((yield* store.listByNode(alice, nodeId)).length, 1);
    assert.equal((yield* store.listByNode(DesignerId.make("dz_other"), nodeId)).length, 0);
  }).pipe(Effect.provide(layer)),
);
