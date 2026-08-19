// ru-code: generic (unclassified-kind) approval routing proof (feature #1 / S5).
// Drives the REAL QwenAdapter over the in-memory fake ACP agent: the agent sends a
// `session/request_permission` for a tool whose kind is NOT one of the classified
// ones (a web-fetch, canonical requestType "dynamic_tool_call" — t3's mechanism,
// see AcpCoreRuntimeEvents.canonicalRequestTypeFromAcpKind; not plan_approval, not
// ask_user_question). The adapter must PARK it behind a Deferred and surface a
// `request.opened` the UI can admit, so the held RPC resolves on the user's
// decision instead of hanging.
//
// Proves: request.opened carries requestType "dynamic_tool_call"; hasParkedRequests
// is TRUE while held; a decision resolves it (exactly one turn.completed, nothing
// left parked); and the exact wire outcome per decision:
//   accept           → { selected, allow_once optionId }
//   decline          → { selected, reject_once optionId }
//   acceptForSession w/ NO allow_always option → { cancelled } (graceful fallback,
//                      no hang — the agent simply exposed no session-scoped option).
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
const THREAD_ID = ThreadId.make("qwen-generic-approval-thread");

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-generic-approval-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type RequestOpened = Extract<ProviderRuntimeEvent, { type: "request.opened" }>;
type WireOutcome = AcpSchema.RequestPermissionResponse["outcome"];

// A full option set (allow_once / allow_always / reject_once) vs a set with NO
// allow_always — the latter is what forces the acceptForSession graceful fallback.
const ALL_OPTIONS: ReadonlyArray<AcpSchema.PermissionOption> = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const NO_ALWAYS_OPTIONS: ReadonlyArray<AcpSchema.PermissionOption> = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

interface GenericCase {
  readonly name: string;
  readonly options: ReadonlyArray<AcpSchema.PermissionOption>;
  readonly decision: ProviderApprovalDecision;
  readonly expectedOutcome: WireOutcome;
}

const CASES: ReadonlyArray<GenericCase> = [
  {
    name: "accept → allow_once optionId",
    options: ALL_OPTIONS,
    decision: "accept",
    expectedOutcome: { outcome: "selected", optionId: "allow" },
  },
  {
    name: "decline → reject_once optionId",
    options: ALL_OPTIONS,
    decision: "decline",
    expectedOutcome: { outcome: "selected", optionId: "deny" },
  },
  {
    name: "acceptForSession without an allow_always option → cancelled (no hang)",
    options: NO_ALWAYS_OPTIONS,
    decision: "acceptForSession",
    expectedOutcome: { outcome: "cancelled" },
  },
];

it.effect.each(CASES)(
  "qwen generic approval: unknown-kind request parks + routes ($name)",
  (testCase) => {
    const capturedOutcomes: WireOutcome[] = [];
    const caseScript: FakeAcpScript = {
      onPermissionOutcome: (outcome) => {
        capturedOutcomes.push(outcome);
      },
      onPrompt: (steps) =>
        steps
          .requestPermission({
            sessionId: FAKE_SESSION_ID,
            toolCall: {
              toolCallId: "web-fetch",
              kind: "fetch",
              rawInput: { url: "https://example.com/data" },
            },
            options: testCase.options,
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
            event.type === "request.opened" ? Deferred.succeed(opened, event) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId: THREAD_ID, input: "fetch the page" }),
      );
      const openedEvent = yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));

      // ru-code: re-pinned to t3's dynamic_tool_call vocabulary (F5, decisions
      // row 26) — an unclassified-kind request surfaced as a generic approval,
      // NOT plan_approval and NOT user-input.
      assert.strictEqual(openedEvent.payload.requestType, "dynamic_tool_call");
      assert.isUndefined(events.find((e) => e.type === "user-input.requested"));
      // Held: hasParkedRequests reports TRUE while the Deferred is parked.
      assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), true);

      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(String(openedEvent.requestId)),
        testCase.decision,
      );
      // Resolves without hanging (acceptForSession-without-allow_always must NOT wedge).
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      // Exact wire outcome per decision.
      assert.lengthOf(capturedOutcomes, 1);
      assert.deepStrictEqual(capturedOutcomes[0], testCase.expectedOutcome);

      // Exactly one settle: request.resolved + one turn.completed, nothing parked.
      assert.isDefined(events.find((e) => e.type === "request.resolved"));
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
