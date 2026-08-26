// ru-code (agentic-flow wave, ap-final T2): THE CLICK MUST REACH QWEN.
//
// The defect this spec exists for (owner live, 2026-08-28): the stop square is
// on the row, the user presses it, and the agent keeps running — with NOTHING
// said anywhere.
//
// Root cause, pinned. `ProviderCommandReactor` declares the stop intent in its
// `ProviderIntentEvent` union (`:66-80`), handles it in `processDomainEvent`'s
// switch (`:1629`), and the handler `processTaskStopRequested` (`:1425`) is
// fully written. But the ONE place domain events are admitted to the worker —
// `processEvent` inside `start` (`:1675-1687`, the sole `worker.enqueue` call
// site) — enumerates eight event types and `"thread.task-stop-requested"` is
// not among them. So the decider emits the intent, the stream drops it on the
// floor, and the handler is unreachable from the live event stream. The switch
// still TYPECHECKS, because the union at `:66-80` does contain the member:
// type-safe, and dead.
//
// Why nothing caught it. `decider.taskStop.test.ts` stops at the decider.
// `backgroundCompletionStop.e2e.test.ts:561` calls `adapter.stopBackgroundTask!`
// DIRECTLY, bypassing the reactor entirely. `agentStopButton.render.test.tsx`
// renders the button with `renderToStaticMarkup` and never clicks it. Every
// link of the chain is pinned and the JOINT between two of them is not — the
// same shape as the wave's own T2 persistence defect, one layer over.
//
// So this spec crosses that joint and nothing else: it dispatches the REAL
// `thread.task.stop` command the button builds (ChatView's
// `threadEnvironment.stopTask` → `stopThreadTask` → `commands.ts:326`) into the
// REAL engine, with the REAL decider, the REAL ProviderCommandReactor, the REAL
// ProviderService and the REAL QwenAdapter over a fake ACP child — and asserts
// that qwen's `qwen/control/session/task/cancel` actually arrives.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  QwenSettings,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";
import { runningTaskEntry } from "./backgroundHarness.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const NOW = "2026-05-01T00:00:00.000Z";
const STOP_AT = "2026-05-01T00:00:05.000Z";
const PROJECT_ID = ProjectId.make("bg-stopcmd-project");
const THREAD_ID = ThreadId.make("bg-stopcmd-thread");
/** The wire tool call id (`Session.ts:6983`). */
const TOOL_CALL_ID = "call_9f8e7d6c";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
/** qwen's REAL registry id — `agent.ts:2842`, random suffix (`:2839`). */
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "5e6f7a8b");

interface RunState {
  readonly script: FakeAcpScript;
  readonly entries: QwenAgentTaskEntry[];
  readonly cancels: Array<{ taskId: string; taskKind: string }>;
}

const makeRunState = (): RunState => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const cancels: Array<{ taskId: string; taskKind: string }> = [];
  const backgroundTasks: FakeBackgroundTasksOptions = {
    entries,
    onCancel: (params) => {
      cancels.push(params);
    },
  };
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) =>
      steps
        .emitBackgroundLaunch({
          toolCallId: TOOL_CALL_ID,
          agentId: TASK_ID,
          subagentName: SUBAGENT_TYPE,
          taskDescription: DESCRIPTION,
        })
        .emitText("launched a background agent")
        .respondOk(),
    backgroundTasks,
  };
  return { script, entries, cancels };
};

const registryOverride =
  (runState: RunState) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
    Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const qwenSettings = yield* decodeQwenSettings({});
        const qwenAdapter = yield* makeQwenAdapter(qwenSettings, {
          cancelGraceMs: 200,
          backgroundPollIntervalMs: 60,
        });
        return makeAdapterRegistryMock({ [QWEN]: qwenAdapter });
      }).pipe(Effect.orDie),
    ).pipe(
      Layer.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(runState.script),
          ServerConfig.layerTest(ctx.workspaceDir, ctx.rootDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      Layer.orDie,
    );

it.live("the per-row stop COMMAND reaches qwen — decider → reactor → adapter → task/cancel", () => {
  const runState = makeRunState();
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: registryOverride(runState) }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("bg-stopcmd-project-create"),
          projectId: PROJECT_ID,
          title: "Background Stop Command Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null,
          commandId: CommandId.make("bg-stopcmd-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Background Stop Command Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("bg-stopcmd-turn-1"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("bg-stopcmd-msg-1"),
            role: "user",
            text: "launch a background agent",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        // The row the user is looking at when they press the square.
        yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.activities.some(
              (activity) =>
                activity.kind === "task.started" &&
                (activity.payload as Record<string, unknown>)["taskId"] === TASK_ID,
            ),
          20_000,
        );
        assert.deepStrictEqual(
          runState.cancels,
          [],
          "nothing may have been cancelled before the button is pressed",
        );

        // THE CLICK. `AgentStopButton.tsx:64` builds exactly this command
        // (`threadEnvironment.stopTask` → `stopThreadTask`, commands.ts:320-329),
        // with `taskId: agent.id` — and `agent.id` is verbatim the persisted
        // row's `taskId` (subagentRuntime.ts:561 `getOrCreate(agents, taskId, …)`,
        // no transformation), which is qwen's own registry key
        // (background-tasks.ts:688 `this.agents.set(entry.agentId, entry)`).
        yield* harness.engine.dispatch({
          type: "thread.task.stop",
          commandId: CommandId.make("bg-stopcmd-stop-1"),
          threadId: THREAD_ID,
          taskId: TASK_ID,
          createdAt: STOP_AT,
        });

        // acpAgent.ts:9388-9397 — `taskKind` is required and validated; omitting
        // it (or sending anything else) is an invalidParams rejection, never a
        // cancel.
        yield* Effect.gen(function* () {
          while (runState.cancels.length === 0) {
            yield* Effect.sleep("25 millis");
          }
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new Error(
                "the stop command never reached qwen: `qwen/control/session/task/cancel` was " +
                  "never sent. The decider emitted `thread.task-stop-requested` and the " +
                  "reactor's `processEvent` filter (ProviderCommandReactor.ts:1675-1687) " +
                  "never enqueued it, so `processTaskStopRequested` never ran — the click " +
                  "dies on the floor, silently",
              ),
          ),
          Effect.orDie,
        );
        assert.deepStrictEqual(runState.cancels, [{ taskId: TASK_ID, taskKind: "agent" }]);

        // And the row settles from the next poll, not from the caller — the one
        // path every other terminal takes (QwenAdapter.ts:5498-5501).
        const settled = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.activities.some(
              (activity) =>
                activity.kind === "task.completed" &&
                (activity.payload as Record<string, unknown>)["taskId"] === TASK_ID,
            ),
          20_000,
        );
        const terminal = settled.activities
          .filter((activity) => activity.kind === "task.completed")
          .map((activity) => activity.payload as Record<string, unknown>)
          .find((payload) => payload["taskId"] === TASK_ID)!;
        assert.strictEqual(terminal["status"], "stopped", "a cancel is a STOP, not a failure");
      }),
    (harness) => harness.dispose.pipe(Effect.timeout("20 seconds"), Effect.ignore),
  ).pipe(Effect.provide(NodeServices.layer));
});
