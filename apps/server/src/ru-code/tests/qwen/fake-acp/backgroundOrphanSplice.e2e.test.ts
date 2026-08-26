// ru-code (agentic-flow wave, P1): THE CORRUPTION REPRO, born red.
//
// qwen's background-completion pseudo-turn pushes `agent_message_chunk`s with NO
// `session/prompt` of ours enclosing them (research qwen-acp-background-agents
// §3.3). Our adapter has no notion of "this content belongs to no turn of mine":
// a `ContentDelta` with an assistant segment already open is folded into that
// segment, ingestion resolves the SAME `messageId` for every delta sharing a
// `(threadId, turnId)` pair (ProviderRuntimeIngestion.ts:1095-1118) and
// concatenates them with NO separator (:1120-1138).
//
// Result, proven empirically before this wave
// (WORKFLOW/waves/agentic-flow/logs/bg-probe/run7.log, `final_messages[4]`): the
// background task's narration and the model's genuine reply for an unrelated
// live turn are glued word-into-word into ONE rendered chat bubble.
//
// This spec asserts the FIXED contract, not the defect — the two texts must
// never share a message row, and each must survive intact. It runs the REAL
// pipeline (fake ACP child → QwenAdapter → ingestion → engine → SQL projection),
// because the splice happens in ingestion's buffer and no adapter-level
// assertion can see it.
//
// Interleaving is by GATE, never by wall clock: the orphan frame must arrive
// while turn 2's own assistant segment is provably open, which a sleep window
// can only make likely.
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { pollUntil } from "./testKit.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const PROJECT_ID = ProjectId.make("bg-splice-project");
const THREAD_ID = ThreadId.make("bg-splice-thread");
const NOW = "2026-05-01T00:00:00.000Z";

const TURN1_TEXT = "first turn reply";
const TURN2_TEXT_A = "second turn reply A";
const TURN2_TEXT_B = "second turn reply B";
/** The background task's own narration — qwen's `displayLine` is built for us. */
const BG_TASK_ID = "general-purpose-call-bg-1";
const BG_DESCRIPTION = "Audit the config";
const BG_SUBAGENT_TYPE = "general-purpose";

type OutOfBand = Parameters<NonNullable<FakeAcpScript["onOutOfBandEmitter"]>>[0];

const makeRunState = () => {
  let promptIndex = 0;
  const gate = Deferred.makeUnsafe<void>();
  const adapterDeltas: string[] = [];
  const outOfBand: { current: OutOfBand | undefined } = { current: undefined };
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) => {
      promptIndex += 1;
      if (promptIndex === 1) {
        steps.emitText(TURN1_TEXT).respondOk();
        return;
      }
      // Turn 2 opens its assistant segment, then PARKS on the gate. The test
      // pushes the orphan background frame into exactly that window and only
      // then opens the gate, so "the orphan landed mid-turn" is a fact of the
      // script rather than a wall-clock hope.
      steps.emitText(TURN2_TEXT_A).awaitGate(gate).emitText(TURN2_TEXT_B).respondOk();
    },
    onOutOfBandEmitter: (emit) => {
      outOfBand.current = emit;
    },
  };
  return { script, gate, adapterDeltas, outOfBand };
};
type RunState = ReturnType<typeof makeRunState>;

const registryOverride =
  (runState: RunState) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
    Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const qwenSettings = yield* decodeQwenSettings({});
        const qwenAdapter = yield* makeQwenAdapter(qwenSettings);
        yield* Stream.runForEach(qwenAdapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "content.delta") runState.adapterDeltas.push(event.payload.delta);
          }),
        ).pipe(Effect.forkScoped);
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

it.live("a background completion frame never splices into a live turn's chat bubble", () => {
  const runState = makeRunState();
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: registryOverride(runState) }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("bg-splice-project-create"),
          projectId: PROJECT_ID,
          title: "Background Splice Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null,
          commandId: CommandId.make("bg-splice-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Background Splice Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        // ── Turn 1: ordinary, completes ──────────────────────────────────
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("bg-splice-turn-1"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("bg-splice-msg-1"),
            role: "user",
            text: "do work",
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

        // ── Turn 2: parks with its segment open ──────────────────────────
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("bg-splice-turn-2"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("bg-splice-msg-2"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });
        yield* pollUntil(
          () => runState.adapterDeltas.some((delta) => delta.includes(TURN2_TEXT_A)),
          "turn 2 opened its assistant segment",
        );

        // ── The orphan: qwen's pseudo-turn speaking mid-turn ─────────────
        const emit = runState.outOfBand.current;
        assert.isDefined(emit, "the fake never handed over its out-of-band emitter");
        yield* emit!.backgroundNotificationDisplay({
          taskId: BG_TASK_ID,
          description: BG_DESCRIPTION,
          subagentType: BG_SUBAGENT_TYPE,
          status: "completed",
          toolUseId: "call-bg-1",
        });
        // The display line qwen itself builds (background-tasks.ts:1556-1564).
        const backgroundText = `Background agent "${BG_SUBAGENT_TYPE}: ${BG_DESCRIPTION}" completed.`;
        yield* pollUntil(
          () => runState.adapterDeltas.some((delta) => delta.includes(backgroundText)),
          "the background narration reached the adapter",
        );
        yield* Deferred.succeed(runState.gate, undefined);

        const completed = yield* harness.waitForThread(
          THREAD_ID,
          (thread) =>
            thread.latestTurn?.state === "completed" &&
            thread.messages.some((message) => message.text.includes(TURN2_TEXT_B)),
          20_000,
        );

        const assistantRows = completed.messages.filter((message) => message.role === "assistant");

        // 1. THE DEFECT: no single row may carry both stories.
        const spliced = assistantRows.find(
          (message) => message.text.includes(backgroundText) && message.text.includes(TURN2_TEXT_B),
        );
        assert.isUndefined(
          spliced,
          `background narration spliced into a real turn's bubble: ${spliced?.text ?? ""}`,
        );

        // 2. The live turn's own reply survives whole and unpolluted.
        const turnRow = assistantRows.find((message) => message.text.includes(TURN2_TEXT_B));
        assert.isDefined(turnRow, "turn 2's own reply never persisted");
        assert.strictEqual(
          turnRow!.text,
          `${TURN2_TEXT_A}${TURN2_TEXT_B}`,
          "turn 2's bubble carries text that is not turn 2's",
        );

        // 3. The background narration is not lost either — it gets its own row.
        const backgroundRow = assistantRows.find((message) =>
          message.text.includes(backgroundText),
        );
        assert.isDefined(backgroundRow, "the background completion never reached the chat");
        assert.notStrictEqual(
          backgroundRow!.id,
          turnRow!.id,
          "the background completion shares a message row with a real turn",
        );
      }),
    (harness) => harness.dispose.pipe(Effect.timeout("20 seconds"), Effect.ignore),
  ).pipe(Effect.provide(NodeServices.layer));
});
