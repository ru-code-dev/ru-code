// ru-code: ask_user_question routing + skip proof (feature #8 / S6). Drives the REAL
// QwenAdapter over the in-memory fake ACP agent: the agent smuggles an
// `ask_user_question` through the standard `session/request_permission` channel
// (toolCall._meta.toolName === "ask_user_question" + rawInput.questions[]). The
// adapter must route it to a structured `user-input.requested` (NOT a plan/approval),
// normalize the questions, and — on the user's answers — encode them back to CLI's
// index-keyed wire shape and resolve the held RPC.
//
// Two paths:
//   SKIP    — respondToUserInput(id, {}) submits empty answers → the model proceeds
//             → held RPC resolves { cancelled } → exactly one turn.completed, nothing
//             parked. (The "I don't want to answer" affordance.)
//   ANSWER  — respondToUserInput(id, {qid: "Fruity"}) → held RPC resolves
//             { selected } and the user-input.resolved event carries the answers.
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
const THREAD_ID = ThreadId.make("qwen-ask-question-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-ask-question-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type UserInputRequested = Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>;
type WireOutcome = AcpSchema.RequestPermissionResponse["outcome"];

// The ask_user_question shape the adapter recognizes: an allow_once submit option +
// a questions[] payload carrying header/question/options. _meta.toolName is the
// primary signal; the questions payload is the secondary one (either routes it).
const askQuestionPermission = (): AcpSchema.RequestPermissionRequest => ({
  sessionId: FAKE_SESSION_ID,
  toolCall: {
    toolCallId: "ask-1",
    _meta: { toolName: "ask_user_question" },
    rawInput: {
      questions: [
        {
          header: "Flavor",
          question: "Which flavor do you prefer?",
          options: [
            { label: "Fruity", description: "Bright and sweet" },
            { label: "Earthy", description: "Deep and rich" },
          ],
        },
      ],
    },
  },
  options: [{ optionId: "submit", name: "Submit", kind: "allow_once" }],
});

it.effect("qwen ask_user_question S6-skip: empty answers resolve the held RPC as cancelled", () => {
  const capturedOutcomes: WireOutcome[] = [];
  const script: FakeAcpScript = {
    onPermissionOutcome: (outcome) => {
      capturedOutcomes.push(outcome);
    },
    onPrompt: (steps) => steps.requestPermission(askQuestionPermission()).respondOk(),
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
      adapter.sendTurn({ threadId: THREAD_ID, input: "ask me" }),
    );
    const requestedEvent = yield* Deferred.await(requested).pipe(Effect.timeout("10 seconds"));

    // Routed to a structured user-input request (NOT approval / plan).
    assert.strictEqual(requestedEvent.payload.questions.length, 1);
    assert.strictEqual(requestedEvent.payload.questions[0]!.header, "Flavor");
    assert.isUndefined(events.find((e) => e.type === "request.opened"));
    assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), true);

    // SKIP: submit empty answers → the model proceeds; the held RPC returns cancelled.
    yield* adapter.respondToUserInput(
      THREAD_ID,
      ApprovalRequestId.make(String(requestedEvent.requestId)),
      {},
    );
    yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    assert.deepStrictEqual(capturedOutcomes, [{ outcome: "cancelled" }]);
    // user-input.resolved fired carrying the (empty) answers; single turn.completed.
    const resolved = events.find(
      (e): e is Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }> =>
        e.type === "user-input.resolved",
    );
    assert.isDefined(resolved);
    assert.deepStrictEqual(resolved!.payload.answers, {});
    assert.lengthOf(
      events.filter((e) => e.type === "turn.completed"),
      1,
    );
    assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});

it.effect("qwen ask_user_question S6-answer: real answers resolve the held RPC as selected", () => {
  const capturedOutcomes: WireOutcome[] = [];
  const script: FakeAcpScript = {
    onPermissionOutcome: (outcome) => {
      capturedOutcomes.push(outcome);
    },
    onPrompt: (steps) => steps.requestPermission(askQuestionPermission()).respondOk(),
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
      adapter.sendTurn({ threadId: THREAD_ID, input: "ask me" }),
    );
    const requestedEvent = yield* Deferred.await(requested).pipe(Effect.timeout("10 seconds"));

    // Answer the first question with its normalized id (read off the request so the
    // encode-back index lookup matches — an empty encode would collapse to cancelled).
    const questionId = requestedEvent.payload.questions[0]!.id;
    yield* adapter.respondToUserInput(
      THREAD_ID,
      ApprovalRequestId.make(String(requestedEvent.requestId)),
      { [questionId]: "Fruity" },
    );
    yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // Non-empty answers → the adapter submits the allow_once optionId ("submit").
    assert.deepStrictEqual(capturedOutcomes, [{ outcome: "selected", optionId: "submit" }]);
    const resolved = events.find(
      (e): e is Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }> =>
        e.type === "user-input.resolved",
    );
    assert.isDefined(resolved);
    assert.deepStrictEqual(resolved!.payload.answers, { [questionId]: "Fruity" });
    assert.lengthOf(
      events.filter((e) => e.type === "turn.completed"),
      1,
    );
    assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});
