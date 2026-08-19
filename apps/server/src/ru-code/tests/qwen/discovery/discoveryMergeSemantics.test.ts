// ru-code: the session-advertisement semantics of the discovery store (locked
// decision): re-advertising a model that is already stored must NOT rewrite
// it — the stored row is kept as-is; slugs missing from the new advertisement
// are deleted; new slugs are added. An identical catalog — in any order — is
// a full no-op: no file write, no `changes` emission, no snapshot respawn
// ripple (the rewrite storm used to reset the user's per-model state
// downstream every session start).
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";

const INSTANCE = ProviderInstanceId.make("qwen");

const CODER = { slug: "coder-model", authMethod: "qwen-oauth", name: "Coder", nTokens: 1_000_000 };
const MINE = { slug: "qwen/qwen3.6-35b-a3b", authMethod: "openai", name: "Mine", nTokens: 262_144 };
const OTHER = { slug: "team/new-128k", authMethod: "openai", name: "New", nTokens: 128_000 };

const testLayer = (prefix: string) =>
  QwenModelDiscoveryStore.layer().pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("discovery store — session re-advertisement merge semantics", () => {
  it.effect(
    "re-advertising the SAME set in a different order is a no-op — no changes fired, no rewrite",
    () =>
      Effect.gen(function* () {
        const store = yield* QwenModelDiscoveryStore;
        yield* store.applyAdvertisement(INSTANCE, [CODER, MINE]);

        const changeCount = yield* Ref.make(0);
        const collector = yield* store.changes.pipe(
          Stream.runForEach(() => Ref.update(changeCount, (count) => count + 1)),
          Effect.forkChild,
        );

        // Next session/new advertises the identical catalog, reordered.
        yield* store.applyAdvertisement(INSTANCE, [MINE, CODER]);
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(collector);

        assert.strictEqual(
          yield* Ref.get(changeCount),
          0,
          "identical set re-advertised in a different order rewrote the store and fired changes",
        );
        // The stored set itself is still the same two models.
        assert.deepStrictEqual((yield* store.get(INSTANCE)).map((model) => model.slug).toSorted(), [
          "coder-model",
          "qwen/qwen3.6-35b-a3b",
        ]);
      }).pipe(Effect.provide(testLayer("qwen-discovery-merge-reorder-")), TestClock.withLive),
  );

  it.effect(
    "a re-advertised slug KEEPS its stored row; missing slugs are deleted; new slugs are added",
    () =>
      Effect.gen(function* () {
        const store = yield* QwenModelDiscoveryStore;
        yield* store.applyAdvertisement(INSTANCE, [CODER, MINE]);

        // Next session re-advertises MINE with flipped metadata (qwen derives
        // authType/window from its CURRENT config+auth state, so these flip
        // run-to-run), drops CODER, and adds OTHER.
        yield* store.applyAdvertisement(INSTANCE, [
          { slug: MINE.slug, authMethod: "qwen-oauth", name: "Mine (relabeled)" },
          OTHER,
        ]);

        const stored = yield* store.get(INSTANCE);
        assert.deepStrictEqual(
          stored.map((model) => model.slug).toSorted(),
          ["qwen/qwen3.6-35b-a3b", "team/new-128k"],
          "delete-missing + add-new must apply",
        );
        const mine = stored.find((model) => model.slug === MINE.slug);
        // Same slug ⇒ same model ⇒ the stored row survives untouched (its
        // authMethod/window are what the user's models actually use).
        assert.deepStrictEqual(
          mine,
          MINE,
          "a re-advertised model was overwritten instead of keeping its stored row",
        );
      }).pipe(Effect.provide(testLayer("qwen-discovery-merge-keep-"))),
  );

  it.effect("control: a disjoint advertisement still adds new slugs and drops missing ones", () =>
    Effect.gen(function* () {
      const store = yield* QwenModelDiscoveryStore;
      yield* store.applyAdvertisement(INSTANCE, [CODER]);
      yield* store.applyAdvertisement(INSTANCE, [OTHER]);
      assert.deepStrictEqual(
        (yield* store.get(INSTANCE)).map((model) => model.slug),
        ["team/new-128k"],
      );
    }).pipe(Effect.provide(testLayer("qwen-discovery-merge-control-"))),
  );
});
