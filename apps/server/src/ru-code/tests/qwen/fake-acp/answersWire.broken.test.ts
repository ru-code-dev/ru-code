// ru-code: BUG-PROOF (intentionally FAILING in port). Full-path proof that a user's
// ask_user_question answer never reaches the agent. Drives the REAL QwenAdapter over
// the fake ACP agent, answers the question, and inspects the FULL RequestPermissionResponse
// the agent receives back (via the onPermissionResponse harness seam) — NOT the
// adapter's internal user-input.resolved event.
//
// qwen reads answers from a top-level `answers` field on the response, keyed by
// stringified question INDEX (qwen-code Session.ts:1513-1517; encode at
// QwenAdapter.ts:346-371 → {"0":"Fruity"}). The adapter returns it
// (QwenAdapter.ts:929-939) but the port's RequestPermissionResponse schema omits the
// field (schema.gen.ts:7768 — no `answers`), so effect Schema strips it on encode
// (rpc.ts:91-95 binds it as the RPC success schema) → the agent receives only
// `outcome`. The existing askUserQuestion.e2e.test.ts is FALSE-GREEN because it only
// checks response.outcome (onPermissionOutcome) and the adapter's pre-encode internal
// event — never the wire-level `answers`.
//
// Asserts the CORRECT behavior (answers survive to the agent) so it FAILS today and
// PASSES once the manual schema field is restored (mirror OLD schema.gen.ts:7760-7797).
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
const THREAD_ID = ThreadId.make("qwen-answers-wire-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-answers-wire-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type UserInputRequested = Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>;

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

it.effect(
  "qwen ask_user_question: the answer reaches the agent on the response `answers` field",
  () => {
    const capturedResponses: AcpSchema.RequestPermissionResponse[] = [];
    const script: FakeAcpScript = {
      onPermissionResponse: (response) => {
        capturedResponses.push(response);
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
            event.type === "user-input.requested"
              ? Deferred.succeed(requested, event)
              : Effect.void,
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

      const questionId = requestedEvent.payload.questions[0]!.id;
      yield* adapter.respondToUserInput(
        THREAD_ID,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { [questionId]: "Fruity" },
      );
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      // The agent got exactly one response. Its outcome is intact...
      assert.lengthOf(capturedResponses, 1);
      const wire = capturedResponses[0]! as Record<string, unknown>;
      assert.deepStrictEqual(wire["outcome"], { outcome: "selected", optionId: "submit" });
      // ...but the answer must ride the `answers` field (index-keyed) to reach qwen.
      // FAILS in port: the schema drops it, so the agent sees no answer at all.
      assert.deepStrictEqual(
        wire["answers"],
        { "0": "Fruity" },
        "the user's answer never reached the agent — `answers` was stripped by the schema",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    );
  },
);
