// ru-code: the discovery store's real persistence contract — hydrate from disk,
// advertisement merge, model-error mutation, per-instance isolation, change
// notifications, and corrupt-file degradation. Runs against a real temp
// stateDir (no mocked fs) so what passes here is what production does.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../../config.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";

const INSTANCE_A = ProviderInstanceId.make("qwen");
const INSTANCE_B = ProviderInstanceId.make("qwen_custom");

const MODEL_A = { slug: "acme/a-8k", authMethod: "openai", name: "A", nTokens: 8_000 };
const MODEL_B = { slug: "acme/b-16k", authMethod: "openai", name: "B", nTokens: 16_000 };
const MODEL_C = { slug: "acme/c-32k", authMethod: "openai", name: "C", nTokens: 32_000 };

const testLayer = (prefix: string) =>
  QwenModelDiscoveryStore.layer().pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("QwenModelDiscoveryStore", () => {
  it.effect("applyAdvertisement persists, get reads back, instances stay isolated", () =>
    Effect.gen(function* () {
      const store = yield* QwenModelDiscoveryStore;
      assert.deepStrictEqual(yield* store.get(INSTANCE_A), []);

      yield* store.applyAdvertisement(INSTANCE_A, [MODEL_A, MODEL_B]);
      yield* store.applyAdvertisement(INSTANCE_B, [MODEL_C]);

      assert.deepStrictEqual(
        (yield* store.get(INSTANCE_A)).map((model) => model.slug),
        ["acme/a-8k", "acme/b-16k"],
      );
      // ru-code: per-instance isolation — B's discovery never leaks into A.
      assert.deepStrictEqual(
        (yield* store.get(INSTANCE_B)).map((model) => model.slug),
        ["acme/c-32k"],
      );

      // A disjoint advertisement drops the old set entirely.
      yield* store.applyAdvertisement(INSTANCE_A, [MODEL_C]);
      assert.deepStrictEqual(
        (yield* store.get(INSTANCE_A)).map((model) => model.slug),
        ["acme/c-32k"],
      );
    }).pipe(Effect.provide(testLayer("qwen-discovery-store-basic-"))),
  );

  it.effect("survives a store rebuild — the file is the real source across restarts", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;

      // "First run" writes; "second run" (a fresh layer over the same stateDir)
      // must hydrate the same set — this is the restart guarantee.
      yield* Effect.gen(function* () {
        const store = yield* QwenModelDiscoveryStore;
        yield* store.applyAdvertisement(INSTANCE_A, [MODEL_A]);
      }).pipe(Effect.provide(QwenModelDiscoveryStore.layer()));

      const hydrated = yield* Effect.gen(function* () {
        const store = yield* QwenModelDiscoveryStore;
        return yield* store.get(INSTANCE_A);
      }).pipe(Effect.provide(QwenModelDiscoveryStore.layer()));

      assert.deepStrictEqual(
        hydrated.map((model) => model.slug),
        ["acme/a-8k"],
      );

      // And the on-disk artifact is where we say it is.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isTrue(
        yield* fs.exists(path.join(serverConfig.stateDir, "qwen-discovered-models.json")),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "qwen-discovery-store-restart-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("applyModelError drops the dead model, merges suggestions, reports change", () =>
    Effect.gen(function* () {
      const store = yield* QwenModelDiscoveryStore;
      yield* store.applyAdvertisement(INSTANCE_A, [MODEL_A, MODEL_B]);

      const changed = yield* store.applyModelError({
        instanceId: INSTANCE_A,
        badModelSlug: "acme/a-8k",
        suggestedModels: [MODEL_C, MODEL_B], // B already present → kept as-is, no dupe
      });
      assert.isTrue(changed);
      assert.deepStrictEqual(
        (yield* store.get(INSTANCE_A)).map((model) => model.slug),
        ["acme/b-16k", "acme/c-32k"],
      );

      // No-op mutation (unknown bad slug, all suggestions present) reports false.
      const unchanged = yield* store.applyModelError({
        instanceId: INSTANCE_A,
        badModelSlug: "acme/ghost",
        suggestedModels: [MODEL_B],
      });
      assert.isFalse(unchanged);
    }).pipe(Effect.provide(testLayer("qwen-discovery-store-error-"))),
  );

  it.effect("changes stream fires the mutated instanceId (the snapshot-refresh signal)", () =>
    Effect.gen(function* () {
      const store = yield* QwenModelDiscoveryStore;
      const firstChange = yield* Effect.forkChild(
        Stream.runCollect(store.changes.pipe(Stream.take(1))),
      );
      // Give the subscriber a beat to attach before publishing.
      yield* Effect.yieldNow;
      yield* store.applyAdvertisement(INSTANCE_B, [MODEL_A]);
      const collected = yield* Fiber.join(firstChange);
      assert.deepStrictEqual([...collected], [INSTANCE_B]);
    }).pipe(Effect.provide(testLayer("qwen-discovery-store-changes-"))),
  );

  it.effect("corrupt file degrades to an empty store (profile models keep serving)", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = path.join(serverConfig.stateDir, "qwen-discovered-models.json");
      yield* fs.makeDirectory(serverConfig.stateDir, { recursive: true });
      yield* fs.writeFileString(filePath, "{ not json at all");

      const models = yield* Effect.gen(function* () {
        const store = yield* QwenModelDiscoveryStore;
        return yield* store.get(INSTANCE_A);
      }).pipe(Effect.provide(QwenModelDiscoveryStore.layer()));
      assert.deepStrictEqual(models, []);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "qwen-discovery-store-corrupt-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
