// ru-code: THE whole-flow warm-engine guarantee (acp-process-pool §4.3) —
// Stop → instant restart → history preserved → no glitches, at the projection
// the web renders. Drives the real reactor → ProviderService → QwenAdapter →
// fake ACP child → ingestion → engine → projection:
//   turn 1 streams → real `thread.turn.interrupt` → the projection settles
//   interrupted/stopped with ZERO error surfaces → an immediate
//   `thread.turn.start` rides the warm slot (no cold spawn), resumes via
//   session/load with the persisted cursor, and completes cleanly — leaving
//   no phantom running turn and no stray overlay files.
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import { FAKE_SESSION_ID, type FakeAcpScript } from "./fakeAcpCore.ts";
import { pollUntil } from "./testKit.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const PROJECT_ID = ProjectId.make("stop-next-turn-project");
const THREAD_ID = ThreadId.make("stop-next-turn-thread");
const NOW = "2026-05-01T00:00:00.000Z";
const STREAMED_TEXT = "streaming before stop";
const SECOND_TURN_TEXT = "second turn reply";

// Per-run harness state — BUILT inside the it() (module-level mutables would
// bleed across tests if this file ever grows a second one).
const makeRunState = () => {
  // Turn 1 PARKS mid-stream (an in-flight prompt for the Stop to cancel);
  // every later prompt completes normally.
  let promptIndex = 0;
  const loadedSessionIds: string[] = [];
  const spawnCounter = { count: 0 };
  const adapterDeltas: string[] = [];
  const adapterTurnStates: string[] = [];
  const script: FakeAcpScript = {
    onPrompt: (steps) => {
      promptIndex += 1;
      if (promptIndex === 1) {
        steps.emitText(STREAMED_TEXT);
        return;
      }
      steps.emitText(SECOND_TURN_TEXT).respondOk();
    },
    onLoadSession: (sessionId) => {
      loadedSessionIds.push(sessionId);
    },
  };
  return { script, loadedSessionIds, spawnCounter, adapterDeltas, adapterTurnStates };
};
type RunState = ReturnType<typeof makeRunState>;

const registryOverride =
  (runState: RunState) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
    Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const qwenSettings = yield* decodeQwenSettings({});
        // Short grace keeps the teardown-latch window realistic but test-fast.
        const qwenAdapter = yield* makeQwenAdapter(qwenSettings, { cancelGraceMs: 200 });
        yield* Stream.runForEach(qwenAdapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "content.delta") {
              runState.adapterDeltas.push(event.payload.delta);
            }
            if (event.type === "turn.completed") {
              runState.adapterTurnStates.push(event.payload.state);
            }
          }),
        ).pipe(Effect.forkScoped);
        return makeAdapterRegistryMock({ [QWEN]: qwenAdapter });
      }).pipe(Effect.orDie),
    ).pipe(
      Layer.provide(
        Layer.provideMerge(
          fakeAcpSpawnerLayer(runState.script, {
            onSpawn: () => {
              runState.spawnCounter.count += 1;
            },
          }),
          ServerConfig.layerTest(ctx.workspaceDir, ctx.rootDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      Layer.orDie,
    );

const waitForAdapter = (what: string, check: () => boolean) =>
  pollUntil(check, `adapter seam: ${what}`);

// Recursive sweep for leftover overlay/slot files after everything settled.
const findStrayFiles = (dir: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const nodePath = yield* Path.Path;
    const found: string[] = [];
    const walk = (current: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          const full = nodePath.join(current, entry);
          const info = yield* fs.stat(full).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") {
            if (entry === "node_modules") continue;
            yield* walk(full);
          } else if (entry === name) {
            found.push(full);
          }
        }
      });
    yield* walk(dir);
    return found;
  });

it.live("stop → instant restart via the warm slot → history preserved, projection clean", () => {
  const runState = makeRunState();
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: registryOverride(runState) }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("stop-next-project-create"),
          projectId: PROJECT_ID,
          title: "Stop Next Turn Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("stop-next-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Stop Next Turn Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        // ── Turn 1: streams, then Stop ───────────────────────────────────
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("stop-next-turn-1"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("stop-next-msg-1"),
            role: "user",
            text: "do work",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });
        yield* waitForAdapter("turn 1 streamed", () =>
          runState.adapterDeltas.some((delta) => delta.includes(STREAMED_TEXT)),
        );
        yield* harness.waitForThread(
          THREAD_ID,
          (thread) => thread.latestTurn?.state === "running",
          20_000,
        );
        const spawnsBeforeStop = runState.spawnCounter.count;
        // ru-code (warm engine v2): 2 boot spares + take/refill on turn 1 — the
        // very first send already rides a prewarmed process.
        assert.strictEqual(spawnsBeforeStop, 3, "turn 1: 2 boot spares + 1 refill (warm take)");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("stop-next-interrupt"),
          threadId: THREAD_ID,
          createdAt: NOW,
        });

        // Projection contract of the Stop: interrupted turn, stopped session,
        // ZERO error surfaces (banner or timeline).
        const stopped = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) =>
            candidate.latestTurn !== null &&
            candidate.latestTurn.state !== "running" &&
            // ru-code: the Stop settles the turn instantly and the session only after the
            // DETACHED teardown (09.3 §4) — gate on BOTH facts this block asserts.
            candidate.session?.status === "stopped",
          20_000,
        );
        assert.strictEqual(stopped.latestTurn!.state, "interrupted");
        assert.strictEqual(stopped.session?.status, "stopped");
        assert.strictEqual(stopped.session?.lastError ?? null, null);
        assert.deepStrictEqual(
          stopped.activities.filter((activity) => activity.tone === "error"),
          [],
          "no error rows for a user stop",
        );
        assert.deepStrictEqual(runState.adapterTurnStates, ["cancelled"]);

        // ── Turn 2, immediately: rides the warm slot, resumes compressed ──
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("stop-next-turn-2"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("stop-next-msg-2"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        const completed = yield* harness.waitForThread(
          THREAD_ID,
          (candidate) => candidate.latestTurn?.state === "completed",
          20_000,
        );
        // Restart proof: the take was spawn-free (only the post-bind refill
        // was added) — the 5-20s cold boot is gone from the user path.
        assert.strictEqual(
          runState.spawnCounter.count,
          4,
          "turn 2 took a warm spare; +1 is its refill",
        );
        // History proof: the new session reconnected via session/load with the
        // persisted cursor — full context preserved.
        assert.deepStrictEqual(runState.loadedSessionIds, [FAKE_SESSION_ID]);
        // Turn 2 is a fresh, distinct, cleanly completed turn.
        assert.notStrictEqual(completed.latestTurn!.turnId, stopped.latestTurn!.turnId);
        assert.strictEqual(completed.session?.lastError ?? null, null);
        assert.deepStrictEqual(
          completed.activities.filter((activity) => activity.tone === "error"),
          [],
          "the whole stop→restart flow produced zero error rows",
        );
        assert.deepStrictEqual(runState.adapterTurnStates, ["cancelled", "completed"]);
        // No phantom running turn anywhere in the final projection.
        assert.isNull(completed.session?.activeTurnId ?? null);

        // Hygiene: no stray overlay files (canonical or slot copies) survive
        // the settled flow anywhere under the harness root.
        assert.deepStrictEqual(
          yield* findStrayFiles(harness.rootDir, "system.json").pipe(
            Effect.provide(NodeServices.layer),
          ),
          [],
          "no leftover overlay files after the flow settled",
        );
      }),
    (harness) => harness.dispose.pipe(Effect.timeout("20 seconds"), Effect.ignore),
  ).pipe(Effect.provide(NodeServices.layer));
});
