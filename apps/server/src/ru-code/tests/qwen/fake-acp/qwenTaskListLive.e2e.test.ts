// ru-code: DIAGNOSTIC (task list / todo_write). Grounded in qwen 0.13.1 on disk:
// the todo_write tool routes through PlanEmitter.emitPlan (Session.ts:893-906,
// which explicitly SKIPS the tool_call event), emitting a single
// `session/update` with `sessionUpdate:"plan"` and
// entries:[{content, priority:"medium", status}] (PlanEmitter.ts). status ∈
// pending|in_progress|completed (types.ts:89-92, todoWrite.ts:51).
//
// This test drives the REAL adapter with that exact frame (emitPlan seam) and
// asserts the SERVER surfaces it as a `turn.plan.updated` runtime event with the
// task steps. If this PASSES, the server catch is correct and the "no task list"
// bug is downstream (web render of turn.plan.updated). If it FAILS, the server
// drops the task list. Either way it pins the layer.
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

import * as ServerConfig from "../../../../config.ts";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";

const decodeQwenSettings = Schema.decodeSync(QwenSettings);
const THREAD_ID = ThreadId.make("qwen-task-list-thread");
const SENTINEL = "TASK_LIST_SENTINEL_DONE";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "ru-code-task-list-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The exact task list the user's scenario produced, in qwen's real status vocab.
const TASKS = [
  { content: "Create a new directory test-app", status: "in_progress" },
  { content: "Create a README.md file", status: "pending" },
  { content: "Add a simple Python script (app.py)", status: "pending" },
];

const script: FakeAcpScript = {
  onPrompt: (steps) => steps.emitPlan(TASKS).emitText(SENTINEL).respondOk(),
};

type PlanUpdated = Extract<ProviderRuntimeEvent, { type: "turn.plan.updated" }>;

it.effect("qwen task list: todo_write plan frame surfaces as turn.plan.updated", () =>
  Effect.gen(function* () {
    const adapter = yield* makeQwenAdapter(decodeQwenSettings({}));
    const events: ProviderRuntimeEvent[] = [];
    const sentinelSeen = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "content.delta" && event.payload.delta === SENTINEL
            ? Deferred.succeed(sentinelSeen, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId: THREAD_ID,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "plan this" });
    yield* Deferred.await(sentinelSeen).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);

    const planEvents = events.filter((e): e is PlanUpdated => e.type === "turn.plan.updated");
    assert.isAtLeast(
      planEvents.length,
      1,
      "server did not surface the task list as turn.plan.updated",
    );
    const steps = planEvents[planEvents.length - 1]!.payload.plan;
    assert.lengthOf(steps, 3);
    assert.strictEqual(steps[0]!.step, "Create a new directory test-app");
    assert.strictEqual(steps[0]!.status, "inProgress");
    assert.strictEqual(steps[1]!.status, "pending");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(fakeAcpSpawnerLayer(script), testServices)),
    TestClock.withLive,
  ),
);
