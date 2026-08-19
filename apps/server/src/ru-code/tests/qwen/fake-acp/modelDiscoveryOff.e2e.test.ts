// ru-code: the QWEN_MODELS_AUTO_DISCOVERY kill-switch's adapter half, over the
// REAL wire shapes. With the flag off, a session-start advertisement (channel A)
// must NOT be persisted and a model-error correction (channel B) must NOT touch
// the store. Own file: the flag is flipped via vi.mock at module scope.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  QwenSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

vi.mock("@ru-code/qwen/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ru-code/qwen/constants")>();
  return { ...actual, QWEN_MODELS_AUTO_DISCOVERY: false };
});

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const INSTANCE_ID = ProviderInstanceId.make("qwen");
const THREAD_ID = ThreadId.make("discovery-off");

const SEEDED = [
  { slug: "seeded/model-64k", authMethod: "openai", name: "Seeded Model 64K", nTokens: 64_000 },
];

it.effect("discovery off: neither channel A nor channel B touches the store", () =>
  Effect.gen(function* () {
    const store = yield* QwenModelDiscoveryStore;
    // Pre-seed so channel B's remove-bad path would be observable if it ran.
    yield* store.applyAdvertisement(INSTANCE_ID, SEEDED);

    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      instanceId: INSTANCE_ID,
      modelDiscoveryStore: store,
    });

    const turnDone = yield* Deferred.make<void>();
    const eventsFiber = yield* Effect.forkChild(
      Stream.runForEach(adapter.streamEvents, (event: ProviderRuntimeEvent) =>
        event.type === "turn.completed" ? Deferred.succeed(turnDone, undefined) : Effect.void,
      ),
    );

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    // The setModel targets the seeded slug; the fake rejects it with the exact
    // qwen-local registry-miss error (channel B input).
    yield* adapter.sendTurn({
      threadId: THREAD_ID,
      input: "hello",
      modelSelection: { instanceId: INSTANCE_ID, model: "seeded/model-64k" },
    });
    yield* Deferred.await(turnDone).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // Channel A did not replace the set with the advertisement; channel B did
    // not drop the "dead" seeded model. The store is byte-identical.
    assert.deepStrictEqual(yield* store.get(INSTANCE_ID), SEEDED);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          fakeAcpSpawnerLayer({
            sessionModels: {
              currentModelId: "advertised/fresh-128k(openai)",
              availableModels: [
                {
                  modelId: "advertised/fresh-128k(openai)",
                  name: "Fresh",
                  _meta: { contextLimit: 128_000 },
                },
              ],
            },
            setModelError: {
              code: -32603,
              message: "Internal error",
              data: { details: "Model 'seeded/model-64k' not found for authType 'openai'" },
            },
            onPrompt: (steps) => steps.emitText("ok").respondOk(),
          }),
          QwenModelDiscoveryStore.layer(),
        ),
        ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-discovery-off-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
    TestClock.withLive,
  ),
);
