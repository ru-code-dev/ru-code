// ru-code: plan-approval held-RPC proof. Drives the REAL QwenAdapter over the in-memory
// fake ACP agent: the fake sends a `session/request_permission` carrying an exit_plan_mode
// plan (rawInput.plan), which the adapter parks behind a Deferred. Asserts the whole flow —
// the plan surfaces (turn.proposed.completed), the held request is exposed as a
// plan_approval (request.opened), `hasParkedRequests` reports TRUE while parked, and an
// `accept` settles it (request.resolved), the held prompt returns, exactly one
// turn.completed fires, and `hasParkedRequests` returns FALSE. Closes the exit_plan_mode +
// hasParkedRequests-true coverage gaps that the surface-only error e2e cannot reach.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
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
const THREAD_ID = ThreadId.make("qwen-plan-thread");
const PLAN_MD = "# Plan\n1. Refactor\n2. Test";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-plan-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const script: FakeAcpScript = {
  onPrompt: (steps) =>
    steps
      .requestPermission({
        sessionId: FAKE_SESSION_ID,
        toolCall: { toolCallId: "exit-plan", rawInput: { plan: PLAN_MD } },
        options: [
          { optionId: "proceed_once", name: "Proceed", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      })
      .respondOk(),
};

type RequestOpened = Extract<ProviderRuntimeEvent, { type: "request.opened" }>;

it.effect(
  "qwen plan approval: parks exit_plan_mode, surfaces plan_approval, resolves on accept",
  () =>
    Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const events: ProviderRuntimeEvent[] = [];
      const opened = yield* Deferred.make<RequestOpened>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened" && event.payload.requestType === "plan_approval"
              ? Deferred.succeed(opened, event)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // sendTurn BLOCKS while the fake holds the prompt behind requestPermission — fork it.
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "plan it" }),
      );

      const openedEvent = yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));

      // GAP: the TRUE branch of hasParkedRequests while a request is held.
      assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), true);
      // the plan markdown surfaced as a proposed plan.
      assert.isDefined(
        events.find(
          (e) => e.type === "turn.proposed.completed" && e.payload.planMarkdown === PLAN_MD,
        ),
      );

      // Approve → resolves the held Deferred → the held requestPermission returns → turn completes.
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(String(openedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      assert.isDefined(events.find((e) => e.type === "request.resolved"));
      assert.lengthOf(
        events.filter((e) => e.type === "turn.completed"),
        1,
      ); // single finalizer
      assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), false); // released
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
      TestClock.withLive,
    ),
);

// ── M2 — the decision-driven held-plan WIRE OUTCOME contract ──────────────────
// The plan-approval optionId is derived from the RESOLVED decision (not the
// runtimeMode mirror), so an approve-time full-access toggle rides the decision:
//   acceptForSession → { selected, proceed_always } → CLI AUTO_EDIT for the
//                      same-turn implementation that runs right after accept
//   accept           → { selected, proceed_once }   → CLI DEFAULT
//   decline / cancel → { cancelled }                → CLI stays in plan mode
// This locks the exact `RequestPermissionResponse.outcome` the adapter sends back
// (captured via the harness's onPermissionOutcome hook) for each decision.

type WireOutcome = AcpSchema.RequestPermissionResponse["outcome"];

interface DecisionCase {
  readonly name: string;
  readonly decision: ProviderApprovalDecision;
  readonly expectedOutcome: WireOutcome;
}

const DECISION_CASES: ReadonlyArray<DecisionCase> = [
  {
    name: "acceptForSession → proceed_always",
    decision: "acceptForSession",
    expectedOutcome: { outcome: "selected", optionId: "proceed_always" },
  },
  {
    name: "accept → proceed_once",
    decision: "accept",
    expectedOutcome: { outcome: "selected", optionId: "proceed_once" },
  },
  {
    name: "decline → cancelled",
    decision: "decline",
    expectedOutcome: { outcome: "cancelled" },
  },
  {
    name: "cancel → cancelled",
    decision: "cancel",
    expectedOutcome: { outcome: "cancelled" },
  },
];

it.effect.each(DECISION_CASES)(
  "qwen plan approval M2: $name (held-plan wire outcome is decision-driven)",
  (testCase) => {
    // Per-case closure state referenced by BOTH the script and the assertions.
    const capturedOutcomes: WireOutcome[] = [];
    const caseScript: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        capturedOutcomes.push(outcome);
      },
      onPrompt: (steps) =>
        steps
          .requestPermission({
            sessionId: FAKE_SESSION_ID,
            toolCall: { toolCallId: "exit-plan", rawInput: { plan: PLAN_MD } },
            options: [
              { optionId: "proceed_once", name: "Proceed", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          })
          .respondOk(),
    };

    return Effect.gen(function* () {
      const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
      const events: ProviderRuntimeEvent[] = [];
      const opened = yield* Deferred.make<RequestOpened>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened" && event.payload.requestType === "plan_approval"
              ? Deferred.succeed(opened, event)
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
        adapter.sendTurn({ threadId: THREAD_ID, input: "plan it" }),
      );
      const openedEvent = yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));

      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(String(openedEvent.requestId)),
        testCase.decision,
      );
      // The turn settles regardless of decision (the fake completes on respondOk
      // once the parked RPC returns) — join proves no hang.
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      // The captured wire outcome is EXACTLY the decision-mapped shape.
      assert.lengthOf(capturedOutcomes, 1);
      assert.deepStrictEqual(capturedOutcomes[0], testCase.expectedOutcome);

      // The projection still saw a single settle: one request.resolved carrying the
      // decision, exactly one turn.completed, nothing left parked.
      const resolvedEvents = events.filter(
        (e): e is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          e.type === "request.resolved",
      );
      assert.lengthOf(resolvedEvents, 1);
      assert.strictEqual(
        (resolvedEvents[0]!.payload as { decision?: ProviderApprovalDecision }).decision,
        testCase.decision,
      );
      assert.lengthOf(
        events.filter((e) => e.type === "turn.completed"),
        1,
      );
      assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), false);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(caseScript), testServices)),
      TestClock.withLive,
    );
  },
);
