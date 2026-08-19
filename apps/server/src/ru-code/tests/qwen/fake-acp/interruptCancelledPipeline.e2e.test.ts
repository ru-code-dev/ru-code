// ru-code: full-pipeline contract for the Stop button — a mid-turn interrupt
// must surface in the PROJECTION as a clean cancellation, never an error.
// Drives the real reactor → ProviderService → QwenAdapter over the fake ACP
// child → ingestion → engine → projection: the fake parks mid-stream, the test
// dispatches the real `thread.turn.interrupt` command, then reads the settled
// thread back from the projection.
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
import * as Stream from "effect/Stream";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const PROJECT_ID = ProjectId.make("interrupt-cancel-project");
const THREAD_ID = ThreadId.make("interrupt-cancel-thread");
const NOW = "2026-05-01T00:00:00.000Z";
const STREAMED_TEXT = "streaming before interrupt";

// The turn streams one chunk and then PARKS (no terminal step) — an in-flight
// prompt for the real interrupt command to cancel.
const script: FakeAcpScript = {
  onPrompt: (steps) => {
    steps.emitText(STREAMED_TEXT);
  },
};

// Assistant deltas are BUFFERED by default (enableAssistantStreaming off), so
// mid-turn text never reaches projected messages — the streamed-text proof is
// taken at the adapter seam instead, and the projection-side in-flight proof
// is latestTurn.state === "running".
const adapterDeltas: string[] = [];
const adapterTurnStates: string[] = [];

const registryOverride = (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
  Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const qwenSettings = yield* decodeQwenSettings({});
      const qwenAdapter = yield* makeQwenAdapter(qwenSettings);
      yield* Stream.runForEach(qwenAdapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "content.delta") {
            adapterDeltas.push(event.payload.delta);
          }
          if (event.type === "turn.completed") {
            adapterTurnStates.push(event.payload.state);
          }
        }),
      ).pipe(Effect.forkScoped);
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

const waitForStreamedDelta = Effect.gen(function* () {
  // 400 × 50ms = 20s bound without wall-clock reads.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (adapterDeltas.some((delta) => delta.includes(STREAMED_TEXT))) {
      return;
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(new Error("the fake's streamed chunk never left the adapter"));
});

it.live("a mid-turn interrupt lands in the projection as a clean cancellation, not an error", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("interrupt-cancel-project-create"),
          projectId: PROJECT_ID,
          title: "Interrupt Cancel Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("interrupt-cancel-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Interrupt Cancel Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("interrupt-cancel-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("interrupt-cancel-msg"),
            role: "user",
            text: "do work",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        // The turn is genuinely mid-stream: the chunk left the adapter and the
        // projection shows the turn running.
        yield* waitForStreamedDelta;
        yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.latestTurn?.state === "running",
          20_000,
        );

        // The real Stop command the web dispatches.
        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("interrupt-cancel-interrupt"),
          threadId: THREAD_ID,
          createdAt: NOW,
        });

        // Bounded wait for the turn to settle out of "running".
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          // ru-code: session.exited lands after turn.completed (QwenAdapter
          // abortSession: turnFinalized → Scope.close → session.exited), so
          // gate on the terminal status or the read races the teardown.
          (candidate) =>
            candidate.latestTurn !== null &&
            candidate.latestTurn.state !== "running" &&
            candidate.session?.status === "stopped",
          20_000,
        );

        // Contract: a user interrupt is a clean stop in the projection —
        // no error surfaces, and the turn settles as "interrupted" (the
        // state the web renders as «You stopped after …»), never as a
        // normal completion.
        assert.strictEqual(
          thread.session?.lastError ?? null,
          null,
          "a clean cancel leaves no session error",
        );
        const errorRows = thread.activities.filter((activity) => activity.tone === "error");
        assert.deepStrictEqual(
          errorRows,
          [],
          "no error-toned activity row was appended for the interrupted turn",
        );
        // The adapter itself reported the turn as cancelled — so a wrong
        // settled label below is lost by ingestion/projection, not the adapter.
        assert.deepStrictEqual(adapterTurnStates, ["cancelled"]);
        const settledState: string = thread.latestTurn!.state;
        assert.strictEqual(
          settledState,
          "interrupted",
          "the user-stopped turn settles as interrupted, not as a normal completion",
        );
        // qwen's Stop is end-force (SIGKILL) by design, so its session ends
        // "stopped" exactly as before this contract — the honest turn label
        // must not come from a session-status change (which would shift the
        // composer phase; providers whose cancel keeps the session alive keep
        // status "ready" — pinned by the ingestion mapping, not here).
        assert.strictEqual(thread.session?.status, "stopped", "the killed session reads stopped");
      }),
    // Bounded dispose so a teardown hang cannot mask the assertion outcome.
    (harness) => harness.dispose.pipe(Effect.timeout("20 seconds"), Effect.ignore),
  ).pipe(Effect.provide(NodeServices.layer)),
);
