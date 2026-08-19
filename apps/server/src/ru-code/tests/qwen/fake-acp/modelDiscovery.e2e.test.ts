// ru-code: END-TO-END model discovery over the REAL wire shapes.
//
// Channel A: qwen 0.13.1 advertises its full model catalog in the session/new
// response (`models: { currentModelId, availableModels[] }`, each entry
// `{ modelId: "id(authType)", name, _meta: { contextLimit } }` — acpAgent.ts
// buildAvailableModels). The adapter must persist it into the per-instance
// store, and the live token feed must use the DISCOVERED model's window as the
// meter denominator (not the hardcoded default).
//
// Channel B: a backend model-not-found (-32603 with the suggestion prose in
// data.details, the openai-SDK envelope) must drop the dead model and merge the
// suggested ones; the qwen-local registry miss at setModel must drop the dead
// model without killing the turn.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const INSTANCE_ID = ProviderInstanceId.make("qwen");
const SENTINEL = "MODEL_DISCOVERY_SENTINEL_DONE";

// The REAL session/new advertisement shape (qwen acpAgent.ts buildAvailableModels).
const ADVERTISED_MODELS = {
  currentModelId: "giga/coder-xl-256k(openai)",
  availableModels: [
    {
      modelId: "giga/coder-xl-256k(openai)",
      name: "Giga Coder XL",
      description: "flagship",
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

const testServices = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

// The fake's script comes from the surrounding layer (fakeAcpSpawnerLayer);
// this driver only runs the session + one turn and captures the event stream.
const runDiscoveryScenario = (input: {
  readonly threadId: ThreadId;
  readonly turnInput?: string;
  readonly modelSelection?: { instanceId: ProviderInstanceId; model: string };
}) =>
  Effect.gen(function* () {
    const store = yield* QwenModelDiscoveryStore;
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
      instanceId: INSTANCE_ID,
      modelDiscoveryStore: store,
    });

    const events: ProviderRuntimeEvent[] = [];
    const turnDone = yield* Deferred.make<void>();
    const eventsFiber = yield* Effect.forkChild(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(turnDone, undefined) : Effect.void,
          ),
        ),
      ),
    );

    yield* adapter.startSession({
      threadId: input.threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({
      threadId: input.threadId,
      input: input.turnInput ?? "hello",
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    });
    yield* Deferred.await(turnDone).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    return { store, events };
  });

it.effect("channel A: session/new advertisement lands in the store with real windows", () =>
  Effect.gen(function* () {
    const { store } = yield* runDiscoveryScenario({
      threadId: ThreadId.make("discovery-channel-a"),
    });

    // Names are ALWAYS humanized from the slug — the advertised labels
    // ("Giga Coder XL", "coder-model") are CLI-side config junk and ignored.
    // Windows resolve slug-suffix-first (256k), contextLimit as the fallback.
    assert.deepStrictEqual(yield* store.get(INSTANCE_ID), [
      {
        slug: "giga/coder-xl-256k",
        authMethod: "openai",
        name: "Giga Coder Xl 256K",
        nTokens: 256_000,
      },
      { slug: "coder-model", authMethod: "qwen-oauth", name: "Coder Model", nTokens: 1_000_000 },
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          fakeAcpSpawnerLayer({
            sessionModels: ADVERTISED_MODELS,
            onPrompt: (steps) => steps.emitText(SENTINEL).respondOk(),
          }),
          QwenModelDiscoveryStore.layer(),
        ),
        testServices("ru-code-discovery-a-"),
      ),
    ),
    TestClock.withLive,
  ),
);

it.effect("meter denominator: live usage rides the DISCOVERED model's window", () =>
  Effect.gen(function* () {
    const { events } = yield* runDiscoveryScenario({
      threadId: ThreadId.make("discovery-meter"),
      modelSelection: { instanceId: INSTANCE_ID, model: "giga/coder-xl-256k" },
    });

    const usageEvents = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
        event.type === "thread.token-usage.updated",
    );
    assert.isAtLeast(usageEvents.length, 1, "no live usage event emitted");
    // 256_000 comes from the session/new advertisement — NOT the 252_000 default.
    assert.strictEqual(usageEvents[usageEvents.length - 1]!.payload.usage.maxTokens, 256_000);
    assert.strictEqual(usageEvents[usageEvents.length - 1]!.payload.usage.usedTokens, 4242);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          fakeAcpSpawnerLayer({
            sessionModels: ADVERTISED_MODELS,
            onPrompt: (steps) => steps.emitUsageChunk(4242).emitText(SENTINEL).respondOk(),
          }),
          QwenModelDiscoveryStore.layer(),
        ),
        testServices("ru-code-discovery-meter-"),
      ),
    ),
    TestClock.withLive,
  ),
);

it.effect("channel B: backend model-not-found drops the dead model and merges suggestions", () =>
  Effect.gen(function* () {
    const { store } = yield* runDiscoveryScenario({
      threadId: ThreadId.make("discovery-channel-b"),
      modelSelection: { instanceId: INSTANCE_ID, model: "giga/coder-xl-256k" },
    });

    // Dead model dropped; backend-suggested models merged in.
    assert.deepStrictEqual(
      (yield* store.get(INSTANCE_ID)).map((model) => model.slug),
      ["coder-model", "giga/fresh-128k", "giga/tiny-8k"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          fakeAcpSpawnerLayer({
            sessionModels: ADVERTISED_MODELS,
            onPrompt: (steps) =>
              // The openai-SDK envelope verbatim in data.details (SDK acp.js wraps
              // a thrown Error as -32603 internalError with details).
              steps.respondError(-32603, "Internal error", {
                details:
                  "404 Model not found. Available models: giga/fresh-128k(openai), giga/tiny-8k(openai)",
              }),
          }),
          QwenModelDiscoveryStore.layer(),
        ),
        testServices("ru-code-discovery-b-"),
      ),
    ),
    TestClock.withLive,
  ),
);

it.effect("channel B: qwen-local setModel registry miss drops the dead model, turn survives", () =>
  Effect.gen(function* () {
    const { store, events } = yield* runDiscoveryScenario({
      threadId: ThreadId.make("discovery-setmodel"),
      modelSelection: { instanceId: INSTANCE_ID, model: "giga/coder-xl-256k" },
    });

    // The dead model is gone; the rest of the advertisement survives.
    assert.deepStrictEqual(
      (yield* store.get(INSTANCE_ID)).map((model) => model.slug),
      ["coder-model"],
    );
    // setModel failures are logged + swallowed — the turn itself completed.
    const completed = events.find((event) => event.type === "turn.completed");
    assert.isDefined(completed);
    assert.strictEqual(
      (completed as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
      "completed",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          fakeAcpSpawnerLayer({
            sessionModels: ADVERTISED_MODELS,
            setModelError: {
              code: -32603,
              message: "Internal error",
              data: {
                details: "Model 'giga/coder-xl-256k' not found for authType 'openai'",
              },
            },
            onPrompt: (steps) => steps.emitText(SENTINEL).respondOk(),
          }),
          QwenModelDiscoveryStore.layer(),
        ),
        testServices("ru-code-discovery-setmodel-"),
      ),
    ),
    TestClock.withLive,
  ),
);
