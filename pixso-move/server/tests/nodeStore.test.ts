import { DesignerId, NodeId } from "@pixso-move/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../src/persistence/sqlite.ts";
import { NodeStore } from "../src/services/nodeStore.ts";
import { NodeStoreLive } from "../src/services/nodeStoreLive.ts";

const layer = NodeStoreLive.pipe(Layer.provide(SqlitePersistenceMemory));
const alice = DesignerId.make("dz_alice");
const bob = DesignerId.make("dz_bob");
const seed = { rootName: "Card", nodesJson: '{"id":"1"}', preview: "iVBOR" };

it.effect("insert persists a record and getById returns it", () =>
  Effect.gen(function* () {
    const store = yield* NodeStore;
    const { nodeId } = yield* store.insert({ designerId: alice, ...seed });
    assert.isString(nodeId);
    const record = yield* store.getById(alice, nodeId);
    assert.isDefined(record);
    assert.equal(record?.designerId, alice);
    assert.equal(record?.nodesJson, '{"id":"1"}');
    assert.isString(record?.addedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("listSummaries omits nodes_json, newest first, isolated by designer", () =>
  Effect.gen(function* () {
    const store = yield* NodeStore;
    yield* store.insert({ designerId: alice, ...seed, rootName: "First" });
    yield* store.insert({ designerId: alice, ...seed, rootName: "Second" });
    yield* store.insert({ designerId: bob, ...seed, rootName: "BobOnly" });
    const summaries = yield* store.listSummaries(alice);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]?.rootName, "Second");
    assert.deepEqual(
      summaries.map((s) => s.rootName),
      ["Second", "First"],
    );
    assert.notInclude(Object.keys(summaries[0] ?? {}), "nodesJson");
  }).pipe(Effect.provide(layer)),
);

it.effect("getById returns undefined for a wrong key or missing id", () =>
  Effect.gen(function* () {
    const store = yield* NodeStore;
    const { nodeId } = yield* store.insert({ designerId: alice, ...seed });
    assert.isUndefined(yield* store.getById(bob, nodeId));
    assert.isUndefined(yield* store.getById(alice, NodeId.make("nope")));
  }).pipe(Effect.provide(layer)),
);

it.effect("listNodeIds and getForProcessing project the right fields", () =>
  Effect.gen(function* () {
    const store = yield* NodeStore;
    const { nodeId } = yield* store.insert({ designerId: alice, ...seed });
    assert.deepEqual(yield* store.listNodeIds(alice), [nodeId]);
    const forProcessing = yield* store.getForProcessing(nodeId);
    assert.equal(forProcessing?.rootName, "Card");
    assert.equal(forProcessing?.nodesJson, '{"id":"1"}');
    assert.isUndefined(yield* store.getForProcessing(NodeId.make("missing")));
  }).pipe(Effect.provide(layer)),
);
