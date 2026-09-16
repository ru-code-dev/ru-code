// ru-code: full-pipeline proof for the live 17:23 report ("the reply never
// appears — but ONLY after a compression"). Drives the production pipeline
// (reactor → ProviderService → real QwenAdapter over the fake ACP child →
// ingestion → engine → projection): after a completed hidden compression
// (the meter button and the composer's `/compress` both dispatch
// `thread.context.compact`), the NEXT turn's assistant reply must land in the
// projected thread messages, turn-bound, exactly like a turn with no
// compression before it.
//
// ru-code (qwen-compression wave): the session is no longer retired by a
// compaction (qwen 0.21.1 swaps the compressed chat into the LIVE session — see
// compactionKeepsSession.e2e.test.ts), so this leg now proves the simpler and
// stronger fact: two compactions and the turn after them all ride ONE live
// provider session, with no `session/load` recovery hop at all.
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
import * as Schema from "effect/Schema";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import { type FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const PROJECT_ID = ProjectId.make("compress-turn-project");
const THREAD_ID = ThreadId.make("compress-turn-thread");
const NOW = "2026-05-01T00:00:00.000Z";
// Replies ECHO their prompt (`Ответ: <prompt>`) so a wait for turn N's reply
// can never be satisfied by turn N-1's — the original same-text-every-turn
// script let the post-compress wait pass on the PRE-compress reply.
const replyFor = (prompt: string) => `Ответ: ${prompt} 👋`;

const promptTexts: string[] = [];
// Session-establishment trail: each `session/load` records its sessionId, each
// fresh `session/new` records "<session/new>" (module-level: accumulates
// across the tests in this file — assert with `includes`, not equality).
const loadedSessionIds: string[] = [];

// "/compress" completes with the REAL qwen frames (period included, counts
// from the live log); every other prompt streams a normal reply.
const script: FakeAcpScript = {
  onPromptText: (text) => promptTexts.push(text),
  onLoadSession: (sessionId) => loadedSessionIds.push(sessionId),
  onCreateSession: () => loadedSessionIds.push("<session/new>"),
  onPrompt: (steps) => {
    const promptText = promptTexts[promptTexts.length - 1];
    if (promptText === "/compress") {
      steps
        .emitCompressProgress()
        .emitCompressResult({ preTokens: 15142, postTokens: 15236 })
        .respondOk();
      return;
    }
    steps.emitText(replyFor(promptText ?? "")).respondOk();
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

it.live("after a hidden compress the NEXT turn keeps the session and projects its reply", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("compress-turn-project-create"),
          projectId: PROJECT_ID,
          title: "Compress Turn Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null, // ru-code: thread-state chat view (extended chat)
          commandId: CommandId.make("compress-turn-thread-create"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Compress Turn Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        // Turn 1 establishes the live session compactContext requires.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("compress-turn-first"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("compress-turn-msg-1"),
            role: "user",
            text: "старт",
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

        const completedCompactionRows = (thread: { activities: ReadonlyArray<unknown> }) =>
          thread.activities.filter(
            (activity) =>
              (activity as { kind?: unknown }).kind === "task.completed" &&
              typeof (
                (activity as { payload?: { taskId?: unknown } }).payload?.taskId ?? undefined
              ) === "string" &&
              (activity as { payload: { taskId: string } }).payload.taskId.startsWith(
                "context-compaction",
              ),
          ).length;
        // The live sequence: meter button, then the composer's /compress —
        // both dispatch thread.context.compact. ru-code (qwen-compression wave):
        // BOTH ride the same live session now, back to back. A second
        // compaction on an already-compacted session is the case that used to
        // need a recovery hop.
        for (const [index, commandId] of [
          "compress-turn-compact-1",
          "compress-turn-compact-2",
        ].entries()) {
          yield* harness.engine.dispatch({
            type: "thread.context.compact",
            commandId: CommandId.make(commandId),
            threadId: THREAD_ID,
            createdAt: NOW,
          });
          yield* harness.waitForThread(
            THREAD_ID,
            (thread) => completedCompactionRows(thread) >= index + 1,
            20_000,
          );
        }

        // THE report: the post-compress turn — its reply must be projected.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("compress-turn-second"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("compress-turn-msg-2"),
            role: "user",
            text: "привет",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          // Wait for the FINALIZED reply — matching mid-stream races the
          // finalizer and the streaming:false assertion below.
          (candidate) =>
            candidate.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text.includes(replyFor("привет")) &&
                message.streaming === false,
            ),
          20_000,
        );

        // Turn-bound (the fold keeps only turn-bound terminal messages visible).
        const reply = thread.messages.findLast(
          (message) => message.role === "assistant" && message.text.includes(replyFor("привет")),
        );
        assert.isDefined(reply);
        assert.isNotNull(reply!.turnId ?? null, "the reply must keep its turn binding");
        assert.strictEqual(reply!.streaming, false, "the reply must be finalized");
        // ru-code (qwen-compression wave): and it got there WITHOUT a single
        // session re-establishment — one `session/new` for the whole leg, no
        // `session/load`. Nothing was retired, so nothing had to be rebuilt.
        assert.deepStrictEqual(
          loadedSessionIds,
          ["<session/new>"],
          `two compactions and the turn after them must ride ONE session (saw: ${loadedSessionIds.join(", ")})`,
        );
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

// The failure surface the removed reactor pre-check used to own: a thread with
// GENUINELY nothing to recover (fresh, never any turn, no persisted binding)
// must still fail into a timeline failure row — now sourced from
// ProviderService's typed routing error via the reactor's catchCause.
it.live("compact on a fresh thread (nothing to recover) still yields the failure row", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        const freshThreadId = ThreadId.make("compact-nothing-to-recover-thread");
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("compact-fresh-project-create"),
          projectId: ProjectId.make("compact-fresh-project"),
          title: "Compact Fresh Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null, // ru-code: thread-state chat view (extended chat)
          commandId: CommandId.make("compact-fresh-thread-create"),
          threadId: freshThreadId,
          projectId: ProjectId.make("compact-fresh-project"),
          title: "Compact Fresh Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });

        yield* harness.engine.dispatch({
          type: "thread.context.compact",
          commandId: CommandId.make("compact-fresh-compact"),
          threadId: freshThreadId,
          createdAt: NOW,
        });
        yield* harness.waitForThread(
          freshThreadId,
          (thread) =>
            thread.activities.some(
              (activity) => activity.kind === "provider.context.compact.failed",
            ),
          20_000,
        );
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

const THREAD_ID_COMPACT_FIRST = ThreadId.make("compact-first-thread");

// The LIVE failing order needs a real RESTART: turn 1 runs in harness #1
// (persisting the thread, the session record and the provider resume cursor),
// then harness #2 reopens the SAME rootDir (same SQLite, fresh runtime — the
// app reload) and the FIRST action is the compaction: the reactor guard reads
// the persisted session record, ProviderService finds no live adapter session
// and takes the RECOVERY path (resolveRoutableSession → recoverSessionForThread
// → adapter.startSession with the persisted cursor). The turn after that must
// still project its reply — live it did not.
it.live("RESTART + compact as the FIRST action — the next turn's reply must project", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const sharedRootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "compress-restart-",
    });
    const instanceId = defaultInstanceIdForDriver(QWEN);

    // ── Phase 1: the "previous app run" — one normal turn, then dispose. ──
    yield* Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ registryOverride, rootDir: sharedRootDir }),
      (harness) =>
        Effect.gen(function* () {
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("compact-first-project-create"),
            projectId: ProjectId.make("compact-first-project"),
            title: "Compact First Project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: { instanceId, model: "m" },
            createdAt: NOW,
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            chatViewMode: null, // ru-code: thread-state chat view (extended chat)
            commandId: CommandId.make("compact-first-thread-create"),
            threadId: THREAD_ID_COMPACT_FIRST,
            projectId: ProjectId.make("compact-first-project"),
            title: "Compact First Thread",
            modelSelection: { instanceId, model: "m" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: harness.workspaceDir,
            createdAt: NOW,
          });
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("compact-first-turn-1"),
            threadId: THREAD_ID_COMPACT_FIRST,
            message: {
              messageId: MessageId.make("compact-first-msg-1"),
              role: "user",
              text: "старт",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: NOW,
          });
          yield* harness.waitForThread(
            THREAD_ID_COMPACT_FIRST,
            (thread) => thread.latestTurn?.state === "completed",
            20_000,
          );
        }),
      (harness) => harness.dispose,
    );

    // ── Phase 2: the "reloaded app" — same persistence, fresh runtime. ──
    yield* Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ registryOverride, rootDir: sharedRootDir }),
      (harness) =>
        Effect.gen(function* () {
          // The projection may have recorded the phase-1 teardown as a stopped
          // session; live the record survives as non-stopped. Reconstruct it.
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("compact-first-session-revive"),
            threadId: THREAD_ID_COMPACT_FIRST,
            session: {
              threadId: THREAD_ID_COMPACT_FIRST,
              status: "ready",
              providerName: "qwen",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            createdAt: NOW,
          });

          // THE live order: compaction FIRST — recovery-resumes the session.
          yield* harness.engine.dispatch({
            type: "thread.context.compact",
            commandId: CommandId.make("compact-first-compact"),
            threadId: THREAD_ID_COMPACT_FIRST,
            createdAt: NOW,
          });
          yield* harness.waitForThread(
            THREAD_ID_COMPACT_FIRST,
            (thread) =>
              thread.activities.some(
                (activity) =>
                  activity.kind === "task.completed" &&
                  typeof (activity.payload as { taskId?: unknown })?.taskId === "string" &&
                  (activity.payload as { taskId: string }).taskId.startsWith("context-compaction"),
              ),
            20_000,
          );

          // Now the regular message — its reply must reach the projection.
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("compact-first-turn-2"),
            threadId: THREAD_ID_COMPACT_FIRST,
            message: {
              messageId: MessageId.make("compact-first-msg-2"),
              role: "user",
              text: "привет",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: NOW,
          });
          const thread = yield* harness.waitForThread(
            THREAD_ID_COMPACT_FIRST,
            // Finalized reply only — see the identical wait in the test above.
            (candidate) =>
              candidate.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.text.includes(replyFor("привет")) &&
                  message.streaming === false,
              ),
            20_000,
          );
          const reply = thread.messages.findLast(
            (message) => message.role === "assistant" && message.text.includes(replyFor("привет")),
          );
          assert.isDefined(reply);
          assert.isNotNull(reply!.turnId ?? null, "the reply must keep its turn binding");
        }),
      (harness) => harness.dispose,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
