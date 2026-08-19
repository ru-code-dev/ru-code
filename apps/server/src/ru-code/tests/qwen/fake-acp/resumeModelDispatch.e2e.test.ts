// ru-code: resume model-dispatch contract. Real qwen 0.13.1 re-advertises its
// full catalog on session/load with qwen-oauth models forced FIRST
// (modelsConfig.ts getAllConfiguredModels), and its loadSession replays
// history before responding — a resumed session is exactly where an
// auto-picked model would sneak in (the 11:45 live failure: resume dispatched
// coder-model(qwen-oauth) the user never chose → «Qwen OAuth credentials
// expired», browser flow risk). The contract, pinned over the REAL adapter +
// fake ACP session/load path:
//   - the SAVED model choice dispatches VERBATIM (its own advertised auth) —
//     including an explicitly chosen qwen-oauth model;
//   - with NO saved choice, the adapter dispatches NOTHING — qwen keeps its
//     own current model; the oauth-first advertised entry is never auto-picked.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  QwenSettings,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenModelDiscoveryStore } from "../../../qwen/discovery/QwenModelDiscoveryStore.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const INSTANCE_ID = ProviderInstanceId.make("qwen");

// Real 0.13.1 session/load advertisement: oauth models FIRST, per-model auth
// riding the modelId.
const ADVERTISED_MODELS = {
  currentModelId: "coder-model(qwen-oauth)",
  availableModels: [
    {
      modelId: "coder-model(qwen-oauth)",
      name: "coder-model",
      description: null,
      _meta: { contextLimit: 1_000_000 },
    },
    {
      modelId: "qwen/qwen3.6-35b-a3b(openai)",
      name: "qwen3.6",
      description: null,
      _meta: { contextLimit: 256_000 },
    },
  ],
};

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-resume-model-dispatch-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Resume a session (valid cursor → session/load) and run one turn with the
// given saved model selection; returns the model config frames + which start
// path ran.
const resumeAndCaptureModelCalls = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection | undefined;
}) =>
  Effect.gen(function* () {
    const configCalls: Array<readonly [string, string | boolean]> = [];
    const loadSessionIds: string[] = [];
    const script: FakeAcpScript = {
      sessionModels: ADVERTISED_MODELS,
      onLoadSession: (sessionId) => {
        loadSessionIds.push(sessionId);
      },
      onSetConfigOption: (configId, value) => {
        configCalls.push([configId, value] as const);
      },
      onPrompt: (steps) => steps.emitText("после резюма").respondOk(),
    };
    yield* Effect.gen(function* () {
      const store = yield* QwenModelDiscoveryStore;
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}), {
        instanceId: INSTANCE_ID,
        modelDiscoveryStore: store,
      });
      const eventsFiber = yield* Effect.forkChild(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );
      yield* adapter.startSession({
        threadId: input.threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: FAKE_SESSION_ID },
      });
      yield* adapter
        .sendTurn({
          threadId: input.threadId,
          input: "продолжаем",
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        })
        .pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(script),
          Layer.provideMerge(QwenModelDiscoveryStore.layer(), testServices),
        ),
      ),
    );
    // The resume path must actually have run — otherwise this test proves nothing.
    assert.deepStrictEqual(loadSessionIds, [FAKE_SESSION_ID], "session/load must be attempted");
    return configCalls.filter(([configId]) => configId === "model");
  }).pipe(TestClock.withLive);

it.effect("resume: the saved model dispatches VERBATIM with its own advertised auth", () =>
  Effect.gen(function* () {
    const modelCalls = yield* resumeAndCaptureModelCalls({
      threadId: ThreadId.make("qwen-resume-saved-model"),
      modelSelection: { instanceId: INSTANCE_ID, model: "qwen/qwen3.6-35b-a3b" },
    });
    assert.deepStrictEqual(modelCalls, [["model", "qwen/qwen3.6-35b-a3b(openai)"]]);
  }),
);

it.effect(
  "resume: NO saved model → NOTHING dispatched (the oauth-first advertised model is never auto-picked)",
  () =>
    Effect.gen(function* () {
      const modelCalls = yield* resumeAndCaptureModelCalls({
        threadId: ThreadId.make("qwen-resume-no-saved-model"),
        modelSelection: { instanceId: INSTANCE_ID, model: "" },
      });
      assert.lengthOf(
        modelCalls,
        0,
        "an empty saved choice must not turn into the advertised oauth-first model",
      );
    }),
);

it.effect("resume: an EXPLICITLY chosen qwen-oauth model still dispatches verbatim", () =>
  Effect.gen(function* () {
    const modelCalls = yield* resumeAndCaptureModelCalls({
      threadId: ThreadId.make("qwen-resume-explicit-oauth-model"),
      modelSelection: { instanceId: INSTANCE_ID, model: "coder-model" },
    });
    assert.deepStrictEqual(modelCalls, [["model", "coder-model(qwen-oauth)"]]);
  }),
);
