// ru-code: FULL-PIPELINE proofs for the compaction history hops the adapter
// e2e cannot see (real reactor → ProviderService → real QwenAdapter over the
// fake ACP child → ingestion → engine → projection):
//   1. the restart-proof breaker state — a COMPLETED compression's raw numbers
//      must survive ingestion (`usage` passthrough into the persisted activity)
//      and be re-derivable by the REAL QwenCompactionHistory service reading
//      the projection, exactly as a restarted server would;
//   2. a send dispatched WHILE a compression runs must surface the B5
//      «Compacting context…» contract in the projection instead of the
//      prompt reaching the wire — through the reactor path, not the adapter
//      called directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
// ru-code: egress-localization chain proof (see assertEgressLocalizesCompactionSummary).
import { setLocale } from "@ru-code/localization";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  QwenSettings,
  ThreadId,
  defaultInstanceIdForDriver,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { QwenCompactionHistory } from "../../../qwen/compaction/QwenCompactionHistory.ts";
import { COMPRESS_IN_PROGRESS_DETAIL } from "../../../qwen/errors/recognizers.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import { localizeWireValue, localizedJsonSerialization } from "../../../localization/wireEgress.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { makeOrchestrationIntegrationHarness } from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const decodeQwenSettings = Schema.decodeEffect(QwenSettings);
const QWEN = ProviderDriverKind.make("qwen");
const COMPRESS_METHOD = "_qwencode/slash_command";
const NOW = "2026-05-01T00:00:00.000Z";

const registryOverride =
  (script: FakeAcpScript) => (ctx: { readonly workspaceDir: string; readonly rootDir: string }) =>
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

const isCompactionActivity = (
  activity: OrchestrationThread["activities"][number],
  kind: "task.progress" | "task.completed",
) =>
  activity.kind === kind &&
  typeof (activity.payload as { taskId?: unknown })?.taskId === "string" &&
  (activity.payload as { taskId: string }).taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX);

// ── ru-code egress-localization chain, asserted on the REAL projection ───────
// This scenario's completed row is the BREAKER TRIP: "Compaction barely reduced the context
// {0}. Auto-compaction disabled." — a `wire: true` dict entry, 340+ chars as a token, i.e.
// LONGER than ingestion's 180-char truncateDetail cap. That made it THE production leak: the
// persisted token was sliced mid-JSON, could never resolve, and rendered raw on every client.
// This proof therefore guards the full chain, on the projection a restarted server would serve:
//  1. PERSISTENCE KEEPS THE TOKEN INTACT — closing sentinel still there (the token-aware
//     truncateDetail seam), and the sentinel is a REAL byte (no double-encoding anywhere in
//     reactor → ingestion → sqlite → projection);
//  2. THE WS DOOR RESOLVES IT — the exact serialization ws.ts installs emits locale display
//     text with zero sentinels left (both locales);
//  3. THE HTTP DOOR RESOLVES IT — `localizeWireValue` + the endpoint's success schema
//     (`OrchestrationThreadDetailSnapshot`) encode, exactly as orchestration/http.ts serves it.
const encodeThreadDetailSnapshot = Schema.encodeUnknownSync(OrchestrationThreadDetailSnapshot);

const assertEgressLocalizesCompactionSummary = (
  detailSnapshot: OrchestrationThreadDetailSnapshot,
): void => {
  const SENTINEL_CODE = 0x1e;
  const completed = detailSnapshot.thread.activities.find((a) =>
    isCompactionActivity(a, "task.completed"),
  );
  assert.isDefined(completed, "no completed compaction activity in the projection");
  const summary = (completed!.payload as { summary?: unknown }).summary;
  assert.isTrue(
    typeof summary === "string" && (summary as string).charCodeAt(0) === SENTINEL_CODE,
    "transform inactive: the projected summary is not an Lc token — this chain proof would prove nothing",
  );
  const token = summary as string;
  // THE truncation regression guard: this token is longer than ingestion's 180-char cap, so a
  // token-blind truncateDetail slices it mid-JSON (closing sentinel gone → resolves never).
  assert.strictEqual(
    token.charCodeAt(token.length - 1),
    SENTINEL_CODE,
    `the persisted token lost its closing sentinel — persist-time truncation cut it mid-JSON (len=${token.length}, tail=${JSON.stringify(token.slice(-40))})`,
  );
  assert.isTrue(
    JSON.stringify(detailSnapshot).includes("\\u001e"),
    "the projected thread lost the token sentinel byte (double-encoding in persistence)",
  );

  const RU_SUMMARY = "Сжатие почти не уменьшило контекст (200000 -> 199000). Автосжатие отключено.";
  const EN_SUMMARY =
    "Compaction barely reduced the context (200000 -> 199000). Auto-compaction disabled.";
  const encodeAs = (locale: "en" | "ru") => {
    setLocale(locale);
    try {
      return String(localizedJsonSerialization.makeUnsafe().encode(detailSnapshot));
    } finally {
      setLocale("en");
    }
  };
  const wireRu = encodeAs("ru");
  {
    // Assert on the DECODED field (not substring-only) so a failure prints the actual value.
    const decoded = JSON.parse(wireRu) as OrchestrationThreadDetailSnapshot;
    const row = decoded.thread.activities.find((a) => isCompactionActivity(a, "task.completed"));
    assert.strictEqual((row!.payload as { summary?: unknown }).summary, RU_SUMMARY);
  }
  assert.isFalse(wireRu.includes("\\u001e"), "WS egress leaked a raw token sentinel");
  assert.isTrue(
    encodeAs("en").includes(EN_SUMMARY),
    "WS egress did not resolve the summary token to English",
  );

  setLocale("ru");
  try {
    const httpSerialized = JSON.stringify(
      encodeThreadDetailSnapshot(localizeWireValue(detailSnapshot)),
    );
    assert.isTrue(
      httpSerialized.includes(RU_SUMMARY),
      "HTTP egress did not resolve the summary token to Russian",
    );
    assert.isFalse(httpSerialized.includes("\\u001e"), "HTTP egress leaked a raw token sentinel");
  } finally {
    setLocale("en");
  }
};

// ── Case 1: completed compression → REAL history service over the projection ─

const HISTORY_PROJECT = ProjectId.make("compaction-history-project");
const HISTORY_THREAD = ThreadId.make("compaction-history-thread");

const historyPromptTexts: string[] = [];

// Turn prompts answer instantly; the hidden "/compress" COMPLETES with real
// numbers — the frames the breaker state must be re-derivable from.
const completingCompressScript: FakeAcpScript = {
  onPromptText: (text) => historyPromptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = historyPromptTexts[historyPromptTexts.length - 1];
    if (promptText === "/compress") {
      steps
        .emitExtNotification(COMPRESS_METHOD, {
          message: "Compressing context...",
          messageType: "info",
        })
        .emitExtNotification(COMPRESS_METHOD, {
          message: "Context compressed (200000 -> 199000)",
          messageType: "info",
        })
        .respondOk();
      return;
    }
    steps.emitText("ok").respondOk();
  },
};

it.live(
  "a completed compression's numbers are re-derivable via the REAL QwenCompactionHistory",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({
        registryOverride: registryOverride(completingCompressScript),
      }),
      (harness) =>
        Effect.gen(function* () {
          const instanceId = defaultInstanceIdForDriver(QWEN);
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("compaction-history-project-create"),
            projectId: HISTORY_PROJECT,
            title: "Compaction History Project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: { instanceId, model: "m" },
            createdAt: NOW,
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            chatViewMode: null, // ru-code: thread-state chat view (extended chat)
            commandId: CommandId.make("compaction-history-thread-create"),
            threadId: HISTORY_THREAD,
            projectId: HISTORY_PROJECT,
            title: "Compaction History Thread",
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
            commandId: CommandId.make("compaction-history-turn"),
            threadId: HISTORY_THREAD,
            message: {
              messageId: MessageId.make("compaction-history-msg"),
              role: "user",
              text: "hi",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: NOW,
          });
          yield* harness.waitForThread(
            HISTORY_THREAD,
            (thread) => thread.latestTurn?.state === "completed",
            20_000,
          );

          yield* harness.engine.dispatch({
            type: "thread.context.compact",
            commandId: CommandId.make("compaction-history-compact"),
            threadId: HISTORY_THREAD,
            createdAt: NOW,
          });
          yield* harness.waitForThread(
            HISTORY_THREAD,
            (thread) => thread.activities.some((a) => isCompactionActivity(a, "task.completed")),
            15_000,
          );
          assert.deepStrictEqual(historyPromptTexts.slice(-1), ["/compress"]);

          // The REAL service (not layerTest) over the harness's live projection —
          // the exact read a restarted server performs to re-arm the breaker.
          const compactionState = yield* Effect.gen(function* () {
            const history = yield* QwenCompactionHistory;
            return yield* history.getThreadCompactionState(HISTORY_THREAD);
          }).pipe(
            Effect.provide(
              QwenCompactionHistory.layer().pipe(
                Layer.provide(Layer.succeed(ProjectionSnapshotQuery, harness.snapshotQuery)),
              ),
            ),
          );

          assert.isNotNull(
            compactionState.lastCompaction,
            "persisted history yields NO compaction numbers — usage did not survive ingestion/projection, breaker is not restart-proof",
          );
          assert.deepStrictEqual(compactionState.lastCompaction, {
            preTokens: 200_000,
            postTokens: 199_000,
          });

          // The same projected thread, pushed through BOTH egress doors (see the helper).
          const detailSnapshot = yield* harness.snapshotQuery
            .getThreadDetailSnapshot(HISTORY_THREAD)
            .pipe(Effect.map(Option.getOrNull), Effect.orDie);
          assert.isNotNull(detailSnapshot, "no thread detail snapshot in the projection");
          assertEgressLocalizesCompactionSummary(detailSnapshot!);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);

// ── Case 2: send during a RUNNING compression, through the reactor path ──────

const B5_PROJECT = ProjectId.make("compaction-b5-project");
const B5_THREAD = ThreadId.make("compaction-b5-thread");
const B5_SEND_TEXT = "hello mid-compress";

const b5PromptTexts: string[] = [];

// Turn prompts answer instantly; the hidden "/compress" emits the compressing
// frame and then PARKS — the compression stays in flight for the whole test.
const parkedCompressScript: FakeAcpScript = {
  onPromptText: (text) => b5PromptTexts.push(text),
  onPrompt: (steps) => {
    const promptText = b5PromptTexts[b5PromptTexts.length - 1];
    if (promptText === "/compress") {
      steps.emitExtNotification(COMPRESS_METHOD, {
        message: "Compressing context...",
        messageType: "info",
      });
      return; // no terminal step — parked
    }
    steps.emitText("ok").respondOk();
  },
};

const carriesB5Signal = (thread: OrchestrationThread): boolean => {
  if (thread.session?.lastError?.includes(COMPRESS_IN_PROGRESS_DETAIL)) return true;
  return thread.activities.some(
    (activity) =>
      activity.summary.includes(COMPRESS_IN_PROGRESS_DETAIL) ||
      JSON.stringify(activity.payload ?? null).includes(COMPRESS_IN_PROGRESS_DETAIL),
  );
};

it.live("a send dispatched during a running compression surfaces B5 in the projection", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      registryOverride: registryOverride(parkedCompressScript),
    }),
    (harness) =>
      Effect.gen(function* () {
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("compaction-b5-project-create"),
          projectId: B5_PROJECT,
          title: "Compaction B5 Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null, // ru-code: thread-state chat view (extended chat)
          commandId: CommandId.make("compaction-b5-thread-create"),
          threadId: B5_THREAD,
          projectId: B5_PROJECT,
          title: "Compaction B5 Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: NOW,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("compaction-b5-turn"),
          threadId: B5_THREAD,
          message: {
            messageId: MessageId.make("compaction-b5-msg"),
            role: "user",
            text: "hi",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });
        yield* harness.waitForThread(
          B5_THREAD,
          (thread) => thread.latestTurn?.state === "completed",
          20_000,
        );

        yield* harness.engine.dispatch({
          type: "thread.context.compact",
          commandId: CommandId.make("compaction-b5-compact"),
          threadId: B5_THREAD,
          createdAt: NOW,
        });
        // The compression is genuinely in flight: the spinner row is projected
        // and the parked "/compress" prompt holds the ACP session busy.
        yield* harness.waitForThread(
          B5_THREAD,
          (thread) => thread.activities.some((a) => isCompactionActivity(a, "task.progress")),
          15_000,
        );

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("compaction-b5-send-during"),
          threadId: B5_THREAD,
          message: {
            messageId: MessageId.make("compaction-b5-msg-during"),
            role: "user",
            text: B5_SEND_TEXT,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: NOW,
        });

        // Bounded poll (40 × 200ms = 8s, well under the test timeout): either
        // the B5 contract shows up in the projection, or the intent never got
        // processed — the reactor path can queue the send behind the parked
        // compression, which makes the guard unreachable and this assertion
        // fail by exhaustion.
        let b5Signal = false;
        for (let attempt = 0; attempt < 40 && !b5Signal; attempt += 1) {
          const thread = yield* harness.snapshotQuery
            .getThreadDetailById(B5_THREAD)
            .pipe(Effect.map(Option.getOrNull), Effect.orDie);
          if (thread !== null && carriesB5Signal(thread)) {
            b5Signal = true;
            break;
          }
          yield* Effect.sleep("200 millis");
        }

        assert.isTrue(
          b5Signal,
          `no «${COMPRESS_IN_PROGRESS_DETAIL}» error/failed row or session.lastError reached the projection within 8s of the send — the B5 fail-fast guard never fired through the reactor path`,
        );
        // The guard must fire BEFORE the wire: the user prompt never reaches
        // the fake agent (only the hidden "/compress" did).
        assert.isFalse(
          b5PromptTexts.includes(B5_SEND_TEXT),
          `the mid-compress prompt reached the wire: ${b5PromptTexts.join(" | ")}`,
        );
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
