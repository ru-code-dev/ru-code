// ru-code: REAL full-server-pipeline per-error proof. For every qwen error the
// classifier can surface over the ACP wire, this drives a REAL turn intent
// (`thread.turn.start`) through the REAL production stack —
// `ProviderCommandReactor` → `ProviderService` → the REAL `QwenAdapter` →
// `ProviderRuntimeIngestion` → the orchestration engine → the projection — with
// ONLY the ACP child process faked (`fakeAcpSpawnerLayer` backing a scripted
// fake ACP agent). Nothing is hand-fed into ingestion; every hop is exercised.
//
// It proves TWO things per error:
//
//   1. SURFACE + TEXT. The projection carries exactly the classified error on the
//      right surface:
//        - Bubble  (A1,A2,A3,A7): the classified text lands in the assistant
//          message; no error-toned activity; session.lastError null; turn completed.
//        - Timeline (A4,A6,E):    an error-toned `task.completed` activity whose
//          summary IS the classified text; session.lastError null; no error bubble.
//        - Timeline+Notification (A5,B1.*,C1,C4,Z,unrecognized): the error activity
//          AND session.lastError == the classified text; no error bubble.
//        (C1 asserts the SURFACE only — its distinct text collapses to C4 at the
//        RPC boundary, a documented effect-acp limitation; see errorSurfaces.e2e.)
//
//   2. NO RACE / NO INTERCEPT (the whole point). For EVERY error:
//        - EXACTLY ONE lastError outcome: the set of distinct non-null lastError
//          values written by `thread.session-set` is either { classifiedText } (T+N)
//          or empty (T / Bubble) — never a second, DIFFERENT overriding write.
//        - NO `provider.turn.start.failed` activity and NO "Provider turn start
//          failed" summary — that is the reactor's generic
//          `recoverTurnStartFailure` output; its presence means the race fired.
//        - NO generic `Cause.pretty` stack-dump lastError — every non-null lastError
//          equals the classified text verbatim.
//        - session.activeTurnId is cleared (turn ended, no hang).
//
// The adapter's finalizer recovers `sendTurn` to success on every classified
// failure, so `providerService.sendTurn` never fails and the reactor's
// `recoverTurnStartFailure` is never reached — that absence is what this test
// pins down against regression.
//
// B3 (spawn failure at session start) is a SEPARATE full-pipeline case at the
// bottom of this file (it does not fit the turn-finalizer ROWS shape): it surfaces
// PRE-TURN at `startSession`, so it flows through the reactor's GENERIC
// start-failure path — `handleTurnStartFailure` → banner (`session.lastError`) +
// `provider.turn.start.failed` timeline row. The adapter PRE-CLASSIFIES the spawn
// failure into a `ProviderAdapterRequestError` whose `.detail` is the classified B3
// text, so the reactor's `formatFailureDetail` shows the classified text as the
// banner (not a raw `Cause.pretty` dump), and the reactor seam uses that same
// classified detail as the timeline row summary (not the generic
// "Provider turn start failed"). See the dedicated `it.live` below.
//
// NOT DRIVABLE through the full pipeline (documented, not silently downgraded):
//   - D1 (empty-input validation): `ProviderService.sendTurn` rejects an
//     empty/attachment-less turn BEFORE the adapter runs (and the turn-start
//     command message text is non-empty by construction — `startTurn` sends
//     "Say hello"), so the adapter's D1 validation finalizer is never reached
//     through the pipeline. The reactor never emits an empty-text turn, so there is
//     no full-pipeline path that reaches D1; its text is pinned by the pure
//     classify() test (recognizers.test.ts). ATTEMPTED and confirmed unreachable.
//   - D2 (session not found): the reactor always `ensureSessionForThread` (starts —
//     or restarts — a session) before dispatching the turn, so the adapter never
//     sees a `sendTurn` for a thread with no session; a missing session is
//     unreachable through the reactor. ATTEMPTED and confirmed unreachable; its
//     text is pinned by the pure classify() test.
//   - B2 (exit, unreadable code) / D3 (defensive fallback): not wire-inducible —
//     pinned by the pure classify() test (recognizers.test.ts).
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
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// ru-code: this fork test owns the REAL QwenAdapter + faked-ACP-child wiring and
// injects it into the upstream harness via its `registryOverride` seam — so the
// upstream `OrchestrationEngineHarness` stays free of qwen specifics.
import { APP_HOME_SLUG, CLI_DISPLAY_NAME } from "@ru-code/branding";
import { makeQwenAdapter } from "../../../qwen/QwenAdapter.ts";
import { ServerConfig } from "../../../../config.ts";
import { ProviderAdapterRegistry } from "../../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../../../provider/testUtils/providerAdapterRegistryMock.ts";
import type { FakeAcpScript } from "./fakeAcpCore.ts";
import { failingAcpSpawnerLayer, fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../../../../../integration/OrchestrationEngineHarness.integration.ts";

const QWEN = ProviderDriverKind.make("qwen");
const decodeQwenSettings = Schema.decodeEffect(QwenSettings);

// ru-code: build a fully-closed `ProviderAdapterRegistry` layer binding the REAL
// QwenAdapter with ONLY the ACP child faked (the scripted fake ACP agent, or a
// spawner that fails outright for the B3 path). Passed to the harness as
// `registryOverride`; the harness supplies its temp workspace/root dirs. The
// spawner is merged OVER `ServerConfig.layerTest + NodeServices.layer` (self wins
// for the duplicated `ChildProcessSpawner`) then `Layer.provide`-closed so the
// fake never leaks to the outer graph's real-process consumers. Construction
// failure is a test defect (`Effect.orDie`), keeping the layer error-free to
// satisfy the harness seam's `Layer.Layer<ProviderAdapterRegistry>` contract.
const makeQwenRegistryOverride =
  (script: FakeAcpScript, opts?: { readonly failSpawn?: boolean }) =>
  (ctx: {
    readonly workspaceDir: string;
    readonly rootDir: string;
  }): Layer.Layer<ProviderAdapterRegistry> =>
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
          opts?.failSpawn ? failingAcpSpawnerLayer() : fakeAcpSpawnerLayer(script),
          ServerConfig.layerTest(ctx.workspaceDir, ctx.rootDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      // ru-code: the provided platform layers carry a build-time PlatformError
      // channel; a failure to build the fake wiring is a test defect, so orDie it
      // to keep the returned layer error-free per the harness seam contract.
      Layer.orDie,
    );

const PROJECT_ID = ProjectId.make("qwen-error-pipeline-project");
const THREAD_ID = ThreadId.make("qwen-error-pipeline-thread");
const FAULT_INJECT_ENV = "RU_CODE_FAULT_INJECT";

function nowIso(): string {
  return "2026-05-01T00:00:00.000Z";
}

/** The three UI surfaces a classified qwen error can resolve to. */
type SurfaceClass = "bubble" | "timeline" | "timelineNotification";

interface ErrorRow {
  readonly id: string;
  readonly script: FakeAcpScript;
  readonly surface: SurfaceClass;
  /**
   * A stable fragment of the classifier's Russian text for this id, asserted to
   * appear in the projection. OMITTED for C1, whose distinct text collapses to
   * C4's transport text at the RPC boundary (surface-only, see file header).
   */
  readonly textIncludes?: string;
  /** Drive the E defect path via the RU_CODE_FAULT_INJECT="defect" adapter seam. */
  readonly faultInject?: boolean;
}

// A trivial happy-prompt script for the adapter-side E defect row (the defect
// throws before the prompt is ever sent, so onPrompt is never reached).
const NOOP_SCRIPT: FakeAcpScript = { onPrompt: (steps) => steps.respondOk() };

const ROWS: ReadonlyArray<ErrorRow> = [
  // ── [Bubble]: friendly assistant text, turn COMPLETES, no row, no banner ──
  {
    id: "A1",
    script: {
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", {
          details: "Model stream ended with empty response text",
        }),
    },
    textIncludes: "empty response",
    surface: "bubble",
  },
  {
    id: "A2",
    script: { onPrompt: (steps) => steps.respondError(429, "rate limit") },
    textIncludes: "Too many requests",
    surface: "bubble",
  },
  {
    id: "A3",
    script: {
      onPrompt: (steps) => steps.respondError(-32603, "internal", { details: "Model unloaded." }),
    },
    textIncludes: "Model unloaded",
    surface: "bubble",
  },
  {
    id: "A7",
    script: {
      onPrompt: (steps) =>
        steps.respondError(-32603, "internal", { details: "Slash command not supported in ACP" }),
    },
    textIncludes: "The command could not be run",
    surface: "bubble",
  },
  // ── [Timeline]: error-toned work-log row, NO banner, NO error bubble ──
  {
    id: "A4",
    script: { onPrompt: (steps) => steps.respondError(-32601, "method not found") },
    textIncludes: `${CLI_DISPLAY_NAME} protocol`,
    surface: "timeline",
  },
  {
    id: "A6",
    script: { onPrompt: (steps) => steps.respondError(-32002, "resource not found") },
    textIncludes: `${CLI_DISPLAY_NAME} resource not found`,
    surface: "timeline",
  },
  {
    id: "E",
    script: NOOP_SCRIPT,
    faultInject: true,
    textIncludes: "An unexpected server error occurred",
    surface: "timeline",
  },
  // ── [Timeline, Notification]: error-toned row AND banner, NO error bubble ──
  {
    id: "A5",
    script: { onPrompt: (steps) => steps.respondError(-32000, "auth required") },
    textIncludes: `${CLI_DISPLAY_NAME} authorization`,
    surface: "timelineNotification",
  },
  {
    id: "B1.41",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(41) },
    textIncludes: "authorization required",
    surface: "timelineNotification",
  },
  {
    id: "B1.42",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(42) },
    textIncludes: "invalid input",
    surface: "timelineNotification",
  },
  {
    id: "B1.44",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(44) },
    textIncludes: "sandbox error",
    surface: "timelineNotification",
  },
  {
    id: "B1.52",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(52) },
    textIncludes: "configuration error",
    surface: "timelineNotification",
  },
  {
    id: "B1.53",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(53) },
    textIncludes: "turn limit reached",
    surface: "timelineNotification",
  },
  {
    id: "B1.54",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(54) },
    textIncludes: "tool error",
    surface: "timelineNotification",
  },
  {
    id: "B1.130",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(130) },
    textIncludes: `The ${CLI_DISPLAY_NAME} session was interrupted`,
    surface: "timelineNotification",
  },
  {
    id: "B1.7",
    script: { onPrompt: (steps) => steps.emitText("partial").exit(7) },
    textIncludes: "code 7",
    surface: "timelineNotification",
  },
  // C1 (malformed frame): SURFACE-ONLY — distinct text collapses to C4 over the
  // wire (parse tag erased at the RPC boundary; the child does not exit).
  {
    id: "C1",
    script: { onPrompt: (steps) => steps.emitText("hi").writeRaw("}{ not json\n") },
    surface: "timelineNotification",
  },
  {
    id: "C4",
    script: { onPrompt: (steps) => steps.emitText("partial").closeTransport() },
    textIncludes: `Connection to ${CLI_DISPLAY_NAME}`,
    surface: "timelineNotification",
  },
  {
    id: "Z",
    script: {
      onPrompt: (steps) => steps.respondError(-32099, "Понятная ошибка провайдера для Z"),
    },
    textIncludes: "Понятная ошибка провайдера для Z",
    surface: "timelineNotification",
  },
  {
    id: "unrecognized",
    script: { onPrompt: (steps) => steps.respondError(-32099, "") },
    textIncludes: "An unexpected error occurred. See the server log for details.",
    surface: "timelineNotification",
  },
];

const withQwenHarness = <A, E>(
  script: FakeAcpScript,
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ registryOverride: makeQwenRegistryOverride(script) }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    // Any non-empty slug works — the fake ACP never validates it, and there is
    // deliberately no qwen entry in DEFAULT_MODEL_BY_PROVIDER anymore.
    const model = "qwen3-test-model";
    const instanceId = defaultInstanceIdForDriver(QWEN);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("qwen-cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Qwen Error Pipeline Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model },
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("qwen-cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Qwen Error Pipeline Thread",
      modelSelection: { instanceId, model },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (harness: OrchestrationIntegrationHarness) =>
  harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make("qwen-cmd-turn-start"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make("qwen-msg-user"),
      role: "user",
      text: "Say hello",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: nowIso(),
  });

// The reactor's generic start-failure output — its presence in the projection
// means `recoverTurnStartFailure` raced/intercepted the classified error.
const GENERIC_START_FAILURE_KIND = "provider.turn.start.failed";
const GENERIC_START_FAILURE_SUMMARY = "Provider turn start failed";

const isSessionSet = (
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "thread.session-set" }> =>
  event.type === "thread.session-set";

const isActivityAppended = (
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> =>
  event.type === "thread.activity-appended";

const errorActivity = (thread: OrchestrationThread) =>
  thread.activities.find(
    (activity) => activity.kind === "task.completed" && activity.tone === "error",
  );

const runRow = (row: ErrorRow) =>
  withQwenHarness(row.script, (harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      // E path: hold RU_CODE_FAULT_INJECT="defect" for the whole turn so the
      // adapter's mid-turn defect fires; the acquireRelease finalizer restores the
      // previous value even if the assertions throw.
      if (row.faultInject) {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env[FAULT_INJECT_ENV];
            process.env[FAULT_INJECT_ENV] = "defect";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env[FAULT_INJECT_ENV];
              else process.env[FAULT_INJECT_ENV] = previous;
            }),
        );
      }

      yield* startTurn(harness);

      // Wait for the turn to reach its terminal projection state (finalized: the
      // active turn is cleared). Predicate differs per surface so we only proceed
      // once the surface-bearing projection is settled.
      const thread = yield* harness.waitForThread(THREAD_ID, (entry) => {
        if (entry.session?.activeTurnId != null) {
          return false;
        }
        if (row.surface === "bubble") {
          return (
            entry.latestTurn?.state === "completed" &&
            entry.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.streaming === false &&
                message.text.includes(row.textIncludes ?? " "),
            )
          );
        }
        const activity = errorActivity(entry);
        if (!activity) {
          return false;
        }
        if (row.textIncludes !== undefined && !activity.summary.includes(row.textIncludes)) {
          return false;
        }
        if (row.surface === "timelineNotification") {
          return entry.session?.lastError != null;
        }
        return true;
      });

      const events = Array.from(
        yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(Effect.orDie),
      );

      // ── (1) SURFACE + TEXT proof on the projection ──
      const activity = errorActivity(thread);
      const assistantErrorBubble = thread.messages.find(
        (message) =>
          message.role === "assistant" &&
          row.textIncludes !== undefined &&
          message.text.includes(row.textIncludes),
      );

      if (row.surface === "bubble") {
        assert.isDefined(row.textIncludes);
        assert.isDefined(assistantErrorBubble, "classified text landed in the assistant bubble");
        assert.isUndefined(activity, "no error-toned work-log activity for a Bubble error");
        assert.isNull(
          thread.session?.lastError ?? null,
          "no red-banner lastError for a Bubble error",
        );
        assert.strictEqual(thread.latestTurn?.state, "completed");
      } else {
        // Timeline / Timeline+Notification: the classified text is the activity
        // summary; it must NEVER also appear as an assistant error bubble.
        assert.isDefined(activity, "error-toned task.completed activity present");
        const classifiedText = activity!.summary;
        assert.isAbove(classifiedText.length, 0);
        if (row.textIncludes !== undefined) {
          assert.include(classifiedText, row.textIncludes);
        }
        assert.isUndefined(
          assistantErrorBubble,
          "classified text must not appear as an error bubble",
        );

        if (row.surface === "timeline") {
          assert.isNull(
            thread.session?.lastError ?? null,
            "Timeline-only error suppresses the red banner (lastError null)",
          );
        } else {
          assert.strictEqual(
            thread.session?.lastError,
            classifiedText,
            "Timeline+Notification error writes the classified text as lastError",
          );
        }
      }

      // ── (2) NO RACE / NO INTERCEPT proof on the domain events ──
      const observedClassifiedText =
        row.surface === "bubble" ? null : (errorActivity(thread)?.summary ?? null);

      // (2a) EXACTLY ONE lastError outcome: the distinct non-null lastError values
      // written across ALL thread.session-set events must be a subset of the single
      // classified text — a second, DIFFERENT write (the generic recovery path)
      // would introduce another value and fail this.
      const distinctLastErrors = Array.from(
        new Set(
          events
            .filter(isSessionSet)
            .map((event) => event.payload.session.lastError)
            .filter((value): value is string => value != null),
        ),
      );
      if (row.surface === "timelineNotification") {
        assert.deepStrictEqual(
          distinctLastErrors,
          [observedClassifiedText],
          "exactly one lastError value written, and it is the classified text (no overriding write)",
        );
      } else {
        assert.deepStrictEqual(
          distinctLastErrors,
          [],
          "no lastError written for a Bubble/Timeline-only error (no overriding write)",
        );
      }

      // (2b) NO reactor generic start-failure activity intercepted the turn.
      const activities = events.filter(isActivityAppended).map((event) => event.payload.activity);
      assert.isUndefined(
        activities.find((entry) => entry.kind === GENERIC_START_FAILURE_KIND),
        "no reactor generic provider.turn.start.failed activity (recoverTurnStartFailure did not fire)",
      );
      assert.isUndefined(
        activities.find((entry) => entry.summary === GENERIC_START_FAILURE_SUMMARY),
        "no reactor generic 'Provider turn start failed' summary",
      );

      // (2c) NO generic Cause.pretty stack-dump lastError: every non-null lastError
      // is the classified text verbatim (already pinned to a single value in 2a);
      // additionally assert it carries no stack-frame markers.
      for (const value of distinctLastErrors) {
        assert.strictEqual(value, observedClassifiedText);
        assert.notInclude(value, "\n    at ");
        assert.notInclude(value, "Cause");
      }

      // (2d) The turn is finalized: the active turn marker is cleared (no hang) —
      // also guaranteed by the wait predicate above; re-assert on the final snapshot.
      assert.isNull(thread.session?.activeTurnId ?? null, "activeTurnId cleared (turn ended)");
    }).pipe(Effect.scoped),
  );

it.live.each(ROWS)("qwen error pipeline: $id delivers ONLY the classified error", (row) =>
  runRow(row),
);

// ─────────────────────────────────────────────────────────────────────────────
// B3 — spawn failure at session start (the PRE-TURN start-failure seam).
//
// Unlike the ROWS above (turn-finalizer errors), B3 surfaces at `startSession`,
// BEFORE any turn runs, so it flows through the reactor's generic start-failure
// path (`handleTurnStartFailure`) — NOT the turn finalizer. Driven through the
// FULL pipeline via the failing spawner (`makeQwenRegistryOverride(..., { failSpawn: true })`): the REAL adapter's
// startSession fails, the adapter pre-classifies it to the B3 request error, and
// the reactor writes the classified banner + timeline summary.
//
// A prior provider session is seeded first so the reactor's
// `setThreadSessionErrorOnTurnStartFailure` has a session to attach the banner
// (`lastError`) to — a realistic B3: a thread that HAD a working session, then the
// cli binary vanished, so the next turn's session (re)start spawn fails.
// ─────────────────────────────────────────────────────────────────────────────

// Exact B3 classified text (recognizers.ts SPAWN_FAILURE). Asserted verbatim.
const B3_CLASSIFIED_TEXT = `Could not start the ${CLI_DISPLAY_NAME} process. Check the installation (run \`${APP_HOME_SLUG}\` again).`;

const seedThreadSession = (harness: OrchestrationIntegrationHarness) =>
  harness.engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("qwen-cmd-session-seed"),
    threadId: THREAD_ID,
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: QWEN,
      providerInstanceId: defaultInstanceIdForDriver(QWEN),
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: nowIso(),
    },
    createdAt: nowIso(),
  });

it.live(
  "qwen error pipeline: B3 spawn failure delivers the classified banner + timeline summary (no Cause.pretty, no race)",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({
        registryOverride: makeQwenRegistryOverride(NOOP_SCRIPT, { failSpawn: true }),
      }),
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness);
          yield* seedThreadSession(harness);
          yield* startTurn(harness);

          // Settle: the active turn is cleared AND the start-failure row + banner
          // are written.
          const thread = yield* harness.waitForThread(THREAD_ID, (entry) => {
            if (entry.session?.activeTurnId != null) {
              return false;
            }
            const startFailure = entry.activities.find(
              (activity) =>
                activity.kind === GENERIC_START_FAILURE_KIND && activity.tone === "error",
            );
            return startFailure !== undefined && entry.session?.lastError != null;
          });

          // ── (1) Banner: lastError is the EXACT B3 text, not a Cause.pretty dump ──
          assert.strictEqual(
            thread.session?.lastError,
            B3_CLASSIFIED_TEXT,
            "session.lastError is the classified B3 text",
          );
          assert.notInclude(thread.session?.lastError ?? "", "\n    at ");
          assert.notInclude(thread.session?.lastError ?? "", "Cause");

          // ── (2) Timeline seam: the start-failure activity summary IS the B3 text ──
          const startFailureActivity = thread.activities.find(
            (activity) => activity.kind === GENERIC_START_FAILURE_KIND,
          );
          assert.isDefined(startFailureActivity, "provider.turn.start.failed activity present");
          assert.strictEqual(startFailureActivity!.tone, "error");
          assert.strictEqual(
            startFailureActivity!.summary,
            B3_CLASSIFIED_TEXT,
            "the reactor seam uses the classified detail as the summary",
          );
          assert.notStrictEqual(
            startFailureActivity!.summary,
            GENERIC_START_FAILURE_SUMMARY,
            "NOT the generic 'Provider turn start failed' summary",
          );

          const events = Array.from(
            yield* Stream.runCollect(harness.engine.readEvents(0)).pipe(Effect.orDie),
          );

          // ── (3) NO RACE: exactly ONE non-null lastError write, and it is the B3
          // text. The seed writes lastError=null (filtered out); a second, DIFFERENT
          // write (e.g. a Cause.pretty dump from a racing path) would fail this. ──
          const distinctLastErrors = Array.from(
            new Set(
              events
                .filter(isSessionSet)
                .map((event) => event.payload.session.lastError)
                .filter((value): value is string => value != null),
            ),
          );
          assert.deepStrictEqual(
            distinctLastErrors,
            [B3_CLASSIFIED_TEXT],
            "exactly one lastError value written, and it is the classified B3 text",
          );
          for (const value of distinctLastErrors) {
            assert.notInclude(value, "\n    at ");
            assert.notInclude(value, "Cause");
          }

          // ── (4) NO DUPLICATE: exactly ONE start-failure activity, summary = B3 ──
          const startFailureActivities = events
            .filter(isActivityAppended)
            .map((event) => event.payload.activity)
            .filter((activity) => activity.kind === GENERIC_START_FAILURE_KIND);
          assert.lengthOf(startFailureActivities, 1);
          assert.strictEqual(startFailureActivities[0]!.summary, B3_CLASSIFIED_TEXT);

          // ── (5) Settled: no active turn left hanging ──
          assert.isNull(thread.session?.activeTurnId ?? null, "activeTurnId cleared (turn ended)");
        }).pipe(Effect.scoped),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
