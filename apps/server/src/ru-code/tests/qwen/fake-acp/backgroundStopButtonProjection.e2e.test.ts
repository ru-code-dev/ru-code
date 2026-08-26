// ru-code (agentic-flow wave, live-issues T2): THE STOP BUTTON'S DATA MUST REACH THE PANEL.
//
// The defect this spec exists for (owner live smoke, reproduced 2026-08-27): a
// genuinely RUNNING background agent rendered no stop square. Not one producer
// was at fault — `QwenAdapter` stamps `isBackgrounded: true` on every background
// row it emits (`:3472` launch, `:1842` post-load probe, `:1454` poll progress,
// `:1476` poll terminal, `:1664` teardown settle) — and every existing spec in
// this wave asserts exactly that, on the RUNTIME EVENT
// (backgroundSingleRow.e2e.test.ts:114 "the stop button reads this field", :166,
// :506, :577, :715; agentSpawnPermissionWire.e2e.test.ts:136, :244).
//
// The field died one layer later, in PERSISTENCE. `taskLinkageActivityFields`
// (ProviderRuntimeIngestion.ts:341-380) is the declared implementation of the
// contract's `taskAgentLinkageFields` bundle — "Optional agent-identity linkage
// carried on EVERY task lifecycle payload … Repeated on progress and terminal
// rows (not just start) so client folds can reconstruct an agent even when its
// start row aged out" (providerRuntime.ts:577-591). `isBackgrounded` is a
// declared member of that bundle, moved there BY THIS WAVE precisely so every
// row would carry it (providerRuntime.ts:677-681). The copier's key list was
// never updated, so `task.started`, `task.progress` and `task.completed` all
// dropped it; only `task.updated`'s hand-spread (`:694-696`) — the vestige of
// the field's OLD home — survived. ClaudeAdapter emits it on `task.updated`
// alone (ClaudeAdapter.ts:3301-3303), which is why the loss looked
// qwen-specific.
//
// Consequence, and the reason this spec asserts on the PERSISTED ROW rather than
// on the event: the panel folds PERSISTED activities, never runtime events
// (ChatView.tsx:2306 `foldSubagentActivities(threadActivities, …)`), the fold
// reads `payload.isBackgrounded` (subagentRuntime.ts:412) and defaults it to
// false (`:374`), and the button is `isBackgrounded && isActiveSubagentStatus`
// (AgentStopButton.tsx:29). An assertion on the event is true and useless — it
// is what let this ship. The consumer half of the seam is pinned by
// `agentStopButtonProjection.test.ts` in apps/web.
//
// So this drives the REAL pipeline (fake ACP child → QwenAdapter → ingestion →
// engine → SQL projection) and reads the thread's own persisted activities.
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
const PROJECT_ID = ProjectId.make("bg-stopbutton-project");
const THREAD_ID = ThreadId.make("bg-stopbutton-thread");
/** The wire tool call id (`Session.ts:6983`). */
const TOOL_CALL_ID = "call_1a2b3c4d";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
/** qwen's REAL registry id — `agent.ts:2842`, random suffix (`:2839`). */
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "5e6f7a8b");

const makeRunState = () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const backgroundTasks: FakeBackgroundTasksOptions = { entries };
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
  return { script, entries };
};
type RunState = ReturnType<typeof makeRunState>;

const registryOverride =
  (runState: RunState) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
    Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const qwenSettings = yield* decodeQwenSettings({});
        const qwenAdapter = yield* makeQwenAdapter(qwenSettings, {
          cancelGraceMs: 200,
          // A short cadence so the progress row lands inside the wait below;
          // the claim is about the row's CONTENT, never about timing.
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

it.live("a background row's `isBackgrounded` survives into the PERSISTED projection", () => {
  const runState = makeRunState();
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: registryOverride(runState) }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("bg-stopbutton-project-create"),
          projectId: PROJECT_ID,
          title: "Background Stop Button Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null,
          commandId: CommandId.make("bg-stopbutton-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Background Stop Button Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("bg-stopbutton-turn-1"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("bg-stopbutton-msg-1"),
            role: "user",
            text: "launch a background agent",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        // Give the poll something new to say, so a `task.progress` row exists
        // too: the contract's whole point is that the flag rides EVERY row, not
        // only the start one (providerRuntime.ts:577-591).
        runState.entries[0] = {
          ...runState.entries[0]!,
          recentActivities: [{ name: "read_file", description: "/a.ts", at: 1_699_999_100_000 }],
        };
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.activities.some((activity) => activity.kind === "task.started") &&
            candidate.activities.some((activity) => activity.kind === "task.progress"),
          20_000,
        );

        const rowsFor = (kind: string) =>
          thread.activities
            .filter((activity) => activity.kind === kind)
            .map((activity) => activity.payload as Record<string, unknown>)
            .filter((payload) => payload["taskId"] === TASK_ID);

        const started = rowsFor("task.started");
        assert.lengthOf(started, 1, "the launch opened exactly one row");
        assert.strictEqual(
          started[0]!["isBackgrounded"],
          true,
          "the PERSISTED start row lost `isBackgrounded` — the panel folds this row " +
            "(ChatView.tsx:2306) and the stop button is `isBackgrounded && active` " +
            "(AgentStopButton.tsx:29), so a running background agent shows no stop square",
        );

        const progress = rowsFor("task.progress");
        assert.isAtLeast(progress.length, 1, "the poll wrote a progress row");
        assert.strictEqual(
          progress[0]!["isBackgrounded"],
          true,
          "the PERSISTED progress row lost `isBackgrounded` — terminal and progress rows " +
            "commonly carry only taskId+status, which is exactly why the contract repeats " +
            "the linkage bundle on every row (providerRuntime.ts:577-591)",
        );

        // The server-stamped sibling proves the row really is an agent row, so a
        // regression cannot be explained away as "this was never an agent".
        assert.strictEqual(started[0]!["agentKind"], "agent");
      }),
    (harness) => harness.dispose.pipe(Effect.timeout("20 seconds"), Effect.ignore),
  ).pipe(Effect.provide(NodeServices.layer));
});
