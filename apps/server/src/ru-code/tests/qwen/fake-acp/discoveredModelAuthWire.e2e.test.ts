// ru-code: the auth suffix on the wire must be the SELECTED model's own auth,
// whatever its source — a DISCOVERED model advertises its auth in the session
// advertisement (`coder-model(qwen-oauth)`), and dispatching it with the
// instance-default auth makes qwen reject the whole setModel
// (`Invalid value "coder-model(openai)" … expected coder-model(qwen-oauth)`).
// Reproduces the field failure byte-for-byte, then pins the contract.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, QwenSettings, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const INSTANCE_ID = ProviderInstanceId.make("qwen");
const THREAD_ID = ThreadId.make("discovered-auth-wire");

// Real 0.13.1 advertisement shape: per-model auth rides the modelId.
const ADVERTISED_MODELS = {
  currentModelId: "qwen/qwen3.6-35b-a3b(openai)",
  availableModels: [
    {
      modelId: "qwen/qwen3.6-35b-a3b(openai)",
      name: "qwen3.6",
      description: null,
      _meta: { contextLimit: 256_000 },
    },
    {
      modelId: "coder-model(qwen-oauth)",
      name: "coder-model",
      description: null,
      _meta: { contextLimit: 1_000_000 },
    },
  ],
};

const configCalls: Array<readonly [string, string | boolean]> = [];

it.effect("a DISCOVERED model dispatches with ITS advertised auth, not the instance default", () =>
  Effect.gen(function* () {
    const store = yield* QwenModelDiscoveryStore;
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      instanceId: INSTANCE_ID,
      modelDiscoveryStore: store,
    });

    const turnDone = yield* Deferred.make<void>();
    const eventsFiber = yield* Effect.forkChild(
      Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnDone, undefined) : Effect.void,
      ),
    );

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({
      threadId: THREAD_ID,
      input: "hello",
      modelSelection: { instanceId: INSTANCE_ID, model: "coder-model" },
    });
    yield* Deferred.await(turnDone).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    const modelCalls = configCalls.filter(([configId]) => configId === "model");
    assert.deepStrictEqual(
      modelCalls,
      [["model", "coder-model(qwen-oauth)"]],
      "the discovered model's own auth must ride the wire",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer({
          sessionModels: ADVERTISED_MODELS,
          onSetConfigOption: (configId, value) => configCalls.push([configId, value]),
          onPrompt: (steps) => steps.emitText("ok").respondOk(),
        }),
        Layer.provideMerge(
          QwenModelDiscoveryStore.layer(),
          ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-discovered-auth-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
    TestClock.withLive,
  ),
);
