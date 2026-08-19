// ru-code: DIAGNOSTIC — multi-question BATCH (qwen 0.13.1 askUserQuestion supports
// 1-4 questions per call: askUserQuestion.ts:40,67-71 "Questions to ask the user
// (1-4 questions)"). The port normalizes ALL questions with per-index ids
// (normalizeQwenQuestions, QwenAdapter.ts:315-340) and encodes each answer keyed by
// its index (encodeQwenAnswersForPermission, :346-371). This drives a REAL 2-question
// frame and asserts the port surfaces BOTH questions (distinct ids) and resolves BOTH
// answers internally — proving the batch logic is ported correctly. The wire delivery
// of `answers` is separately broken by #1 (schema strip) for any question count;
// this test pins the batch SURFACING+RESOLUTION as correct.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
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
import type * as AcpSchema from "effect-acp/schema";

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-ask-batch-thread");
const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-ask-batch-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type UserInputRequested = Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>;

// A REAL 2-question batch (qwen sends questions[] with header/question/options/multiSelect).
const batchPermission = (): AcpSchema.RequestPermissionRequest => ({
  sessionId: FAKE_SESSION_ID,
  toolCall: {
    toolCallId: "ask-batch",
    _meta: { toolName: "ask_user_question" },
    rawInput: {
      questions: [
        {
          header: "Flavor",
          question: "Which flavor?",
          options: [{ label: "Fruity" }, { label: "Earthy" }],
        },
        {
          header: "Size",
          question: "Which size?",
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ],
    },
  },
  options: [{ optionId: "submit", name: "Submit", kind: "allow_once" }],
});

it.effect("qwen ask_user_question BATCH: both questions surface and resolve", () => {
  const script: FakeAcpScript = {
    onPrompt: (steps) => steps.requestPermission(batchPermission()).respondOk(),
  };
  return Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const requested = yield* Deferred.make<UserInputRequested>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "user-input.requested" ? Deferred.succeed(requested, event) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    const turnFiber = yield* Effect.forkChild(
      adapter.sendTurn({ threadId: THREAD_ID, input: "ask me two" }),
    );
    const req = yield* Deferred.await(requested).pipe(Effect.timeout("10 seconds"));

    // Both questions surfaced, distinct ids, correct headers.
    assert.lengthOf(req.payload.questions, 2);
    assert.strictEqual(req.payload.questions[0]!.header, "Flavor");
    assert.strictEqual(req.payload.questions[1]!.header, "Size");
    assert.notStrictEqual(req.payload.questions[0]!.id, req.payload.questions[1]!.id);

    // Answer BOTH by their ids.
    const q0 = req.payload.questions[0]!.id;
    const q1 = req.payload.questions[1]!.id;
    yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make(String(req.requestId)), {
      [q0]: "Fruity",
      [q1]: "Large",
    });
    yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // Internal resolution carries BOTH answers (batch resolution correct).
    const resolved = events.find(
      (e): e is Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }> =>
        e.type === "user-input.resolved",
    );
    assert.isDefined(resolved);
    assert.deepStrictEqual(resolved!.payload.answers, { [q0]: "Fruity", [q1]: "Large" });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});
