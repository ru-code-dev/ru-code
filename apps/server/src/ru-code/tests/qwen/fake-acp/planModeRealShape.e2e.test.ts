// ru-code: DIAGNOSTIC (plan mode / exit_plan_mode) against the EXACT qwen 0.13.1
// wire shape. qwen sends exit_plan_mode through session/request_permission with
// toolCall.kind:"switch_mode" + rawInput:{plan} + content, and NO _meta.toolName
// (qwen-code Session.ts:782-795, ToolCallEmitter.mapToolKind:247-251). options are
// proceed_always/proceed_once/cancel (permissionUtils.ts:172-189).
//
// The port detects exit_plan_mode via readExitPlanPayload → rawInput.plan
// (QwenAdapter.ts:287-295); _meta.toolName is absent in the real frame, so that
// predicate is dead — detection hinges entirely on rawInput.plan being present,
// which 0.13.1 sends. This test drives the REAL frame and asserts the port catches
// it: surfaces turn.proposed.completed{planMarkdown} + request.opened{plan_approval}
// and parks the RPC. If it PASSES, plan catching is correct server-side. If it
// FAILS, the port drops the real plan frame.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { QwenSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
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
const THREAD_ID = ThreadId.make("qwen-plan-real-shape-thread");
const PLAN_MD = "## Plan\n1. Create dir\n2. Add README";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-plan-real-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The EXACT 0.13.1 exit_plan_mode permission request: kind:"switch_mode",
// rawInput:{plan}, content carrying the plan, NO _meta.toolName; real option set.
const exitPlanModePermission = (): AcpSchema.RequestPermissionRequest =>
  ({
    sessionId: FAKE_SESSION_ID,
    toolCall: {
      toolCallId: "exit-plan-1",
      status: "pending",
      title: "Plan",
      kind: "switch_mode",
      content: [{ type: "content", content: { type: "text", text: PLAN_MD } }],
      rawInput: { plan: PLAN_MD },
    },
    options: [
      { optionId: "proceed_always", name: "Yes, and auto-accept edits", kind: "allow_always" },
      { optionId: "proceed_once", name: "Yes, and manually approve edits", kind: "allow_once" },
      { optionId: "cancel", name: "No, keep planning (esc)", kind: "reject_once" },
    ],
    // exact real wire shape
  }) as any;

type RequestOpened = Extract<ProviderRuntimeEvent, { type: "request.opened" }>;

it.effect("qwen plan mode: real 0.13.1 exit_plan_mode frame is caught and parked", () => {
  const script: FakeAcpScript = {
    onPrompt: (steps) => steps.requestPermission(exitPlanModePermission()).respondOk(),
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
    yield* Effect.forkChild(adapter.sendTurn({ threadId: THREAD_ID, input: "make a plan" }));

    const openedEvent = yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    // Caught as a plan approval (not a generic tool approval), plan text surfaced,
    // and the RPC is parked awaiting the user.
    assert.strictEqual(openedEvent.payload.requestType, "plan_approval");
    const proposed = events.find((e) => e.type === "turn.proposed.completed");
    assert.isDefined(proposed, "plan was not surfaced as turn.proposed.completed");
    assert.strictEqual(yield* adapter.hasParkedRequests!(THREAD_ID), true);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  );
});
