// ru-code: LIVE-VISIBILITY proof for the compaction spinner row — the guarantee
// the adapter-level e2e cannot give. Drives the FULL production pipeline
// (real reactor → ProviderService → real QwenAdapter over the fake ACP child →
// ingestion → engine → projection): after `thread.context.compact` is
// dispatched, the «Compacting context…» task.progress row must be readable
// from the projection WHILE the compression is still running (the fake parks
// the /compress prompt forever), NOT together with the result.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
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
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const PROJECT_ID = ProjectId.make("compact-live-project");
const THREAD_ID = ThreadId.make("compact-live-thread");
const NOW = "2026-05-01T00:00:00.000Z";

const promptTexts: string[] = [];

// Turn prompts answer instantly; the hidden "/compress" emits the real
// "Compressing context..." frame and then PARKS — compression "runs" forever.
const script: FakeAcpScript = {
  onPromptText: (text) => promptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = promptTexts[promptTexts.length - 1];
    if (promptText === "/compress") {
      steps.emitExtNotification("_qwencode/slash_command", {
        message: "Compressing context...",
        messageType: "info",
      });
      return; // no terminal step — parked
    }
    steps.emitText("ok").respondOk();
  },
};

const registryOverride = (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
  Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const qwenSettings = yield* decodeQwenSettings({});
      const qwenAdapter = yield* makeQwenAdapter(qwenSettings);
      return makeAdapterRegistryMock({ [QWEN]: qwenAdapter });
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      Layer.provideMerge(
        fakeAcpSpawnerLayer(script),
        ServerConfig.layerTest(ctx.workspaceDir, ctx.rootDir).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
    Layer.orDie,
  );

it.live("the spinner row is in the projection WHILE the compression is still running", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("compact-live-project-create"),
          projectId: PROJECT_ID,
          title: "Compact Live Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("compact-live-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Compact Live Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        // One quick turn establishes the live session compactContext requires.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("compact-live-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("compact-live-msg"),
            role: "user",
            text: "hi",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });
        yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.latestTurn?.state === "completed",
          20_000,
        );

        yield* harness.engine.dispatch({
          type: "thread.context.compact",
          commandId: CommandId.make("compact-live-compact"),
          threadId: THREAD_ID,
          createdAt: NOW,
        });

        // THE guarantee: the progress row lands in the projection while the
        // /compress prompt is still parked (compression never completes here).
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.activities.some(
              (activity) =>
                activity.kind === "task.progress" &&
                typeof (activity.payload as { taskId?: unknown })?.taskId === "string" &&
                (activity.payload as { taskId: string }).taskId.startsWith(
                  CONTEXT_COMPACTION_TASK_PREFIX,
                ),
            ),
          15_000,
        );

        // Still mid-compression: no completion row exists.
        const completionRow = thread.activities.find(
          (activity) =>
            activity.kind === "task.completed" &&
            typeof (activity.payload as { taskId?: unknown })?.taskId === "string" &&
            (activity.payload as { taskId: string }).taskId.startsWith(
              CONTEXT_COMPACTION_TASK_PREFIX,
            ),
        );
        assert.isUndefined(completionRow, "completion row present — row was NOT live");
        assert.deepStrictEqual(promptTexts.slice(-1), ["/compress"]);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
