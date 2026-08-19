// ru-code: per-turn WIRE proof for the composer's mode/model dropdowns. Drives the
// REAL QwenAdapter over the in-memory fake ACP agent and captures every
// `session/set_config_option` frame:
//   - resolveQwenMode: interactionMode "plan" wins over ANY runtimeMode (["mode","plan"]);
//     the new-chat default runtimeMode (auto-accept-edits) maps to ["mode","auto-edit"].
//   - setModel: a custom-model selection dispatches configId "model" with the encoded
//     `${slug}(${authMethod})` value; an EMPTY model («not selected») skips setModel
//     entirely — the CLI runs its own defaults.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  QwenSettings,
  ThreadId,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeUnknownSync(QwenSettings);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-mode-model-wire-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// One session + one turn over the fake agent; returns every set_config_option
// frame the adapter dispatched (mode AND model), in wire order.
const captureTurnConfigCalls = (input: {
  readonly threadId: ThreadId;
  readonly settings?: unknown;
  readonly startRuntimeMode: RuntimeMode;
  readonly turn: Omit<ProviderSendTurnInput, "threadId" | "input">;
}): Effect.Effect<ReadonlyArray<readonly [string, string | boolean]>> =>
  Effect.gen(function* () {
    const configCalls: Array<readonly [string, string | boolean]> = [];
    const script: FakeAcpScript = {
      onSetConfigOption: (configId, value) => {
        configCalls.push([configId, value] as const);
      },
      onPrompt: (steps) => {
        steps.emitText("ответ").respondOk();
      },
    };
    yield* Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings(input.settings ?? {}));
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, () => Effect.void).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: input.threadId,
        cwd: process.cwd(),
        runtimeMode: input.startRuntimeMode,
      });
      yield* adapter
        .sendTurn({ threadId: input.threadId, input: "проверка провода", ...input.turn })
        .pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    );
    return configCalls;
  }).pipe(TestClock.withLive, Effect.orDie);

const modeCallsOf = (calls: ReadonlyArray<readonly [string, string | boolean]>) =>
  calls.filter(([configId]) => configId === "mode");

const modelCallsOf = (calls: ReadonlyArray<readonly [string, string | boolean]>) =>
  calls.filter(([configId]) => configId === "model");

it.effect("interactionMode plan wins over full-access → wire frame [mode, plan]", () =>
  Effect.gen(function* () {
    const configCalls = yield* captureTurnConfigCalls({
      threadId: ThreadId.make("qwen-wire-plan-wins"),
      startRuntimeMode: "full-access",
      turn: { runtimeMode: "full-access", interactionMode: "plan" },
    });
    assert.deepStrictEqual(modeCallsOf(configCalls), [["mode", "plan"]]);
  }),
);

it.effect("new-chat default runtimeMode (auto-accept-edits) → wire frame [mode, auto-edit]", () =>
  Effect.gen(function* () {
    // The composer's new-chat default is auto-accept-edits; pin both the default
    // itself and its wire mapping.
    assert.strictEqual(DEFAULT_RUNTIME_MODE, "auto-accept-edits");
    const configCalls = yield* captureTurnConfigCalls({
      threadId: ThreadId.make("qwen-wire-default-auto-edit"),
      startRuntimeMode: DEFAULT_RUNTIME_MODE,
      turn: { runtimeMode: DEFAULT_RUNTIME_MODE },
    });
    assert.deepStrictEqual(modeCallsOf(configCalls), [["mode", "auto-edit"]]);
  }),
);

it.effect("custom-model selection dispatches configId 'model' with `${slug}(${authMethod})`", () =>
  Effect.gen(function* () {
    const configCalls = yield* captureTurnConfigCalls({
      threadId: ThreadId.make("qwen-wire-custom-model"),
      settings: { customModels: [{ slug: "custom-x", authMethod: "anthropic" }] },
      startRuntimeMode: DEFAULT_RUNTIME_MODE,
      turn: {
        runtimeMode: DEFAULT_RUNTIME_MODE,
        modelSelection: decodeModelSelection({ instanceId: "qwen", model: "custom-x" }),
      },
    });
    assert.deepStrictEqual(modelCallsOf(configCalls), [["model", "custom-x(anthropic)"]]);
  }),
);

it.effect("empty model («not selected») skips setModel — no configId 'model' frame at all", () =>
  Effect.gen(function* () {
    const configCalls = yield* captureTurnConfigCalls({
      threadId: ThreadId.make("qwen-wire-empty-model-skip"),
      startRuntimeMode: DEFAULT_RUNTIME_MODE,
      turn: {
        runtimeMode: DEFAULT_RUNTIME_MODE,
        modelSelection: decodeModelSelection({ instanceId: "qwen", model: "" }),
      },
    });
    assert.lengthOf(modelCallsOf(configCalls), 0);
  }),
);
