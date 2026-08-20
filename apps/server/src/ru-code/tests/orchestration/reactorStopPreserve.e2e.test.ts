// ru-code: preserve-modes seam — the REACTOR'S STOP PATH. The seam pinned the
// ingestion's carried-over session writes; the reactor's
// `processSessionStopRequested` is the remaining production dispatcher that
// carries `lastError` over from its own projection-snapshot read (the shape a
// user hits when stopping BECAUSE an error just appeared: the stop's stale
// read must never erase the racing banner). This drives the REAL pipeline —
// `thread.session.stop` command → decider → `thread.session-stop-requested`
// event → real ProviderCommandReactor → engine dispatch — and pins BOTH the
// command shape (via the harness's command-observation seam; the flag is
// resolved away in events) and the projected outcome.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../../../../integration/OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.make("reactor-stop-preserve-project");
const THREAD_ID = ThreadId.make("reactor-stop-preserve-thread");
const BANNER = "classified banner that a stop must not erase";

// Fixed timestamps (no wall clock): the STOP time differs from the seed time
// so the outcome wait can key on the reactor write's updatedAt.
const SEED_AT = "2026-05-01T00:00:00.000Z";
const STOP_AT = "2026-05-01T00:00:01.000Z";

type SessionSetCommand = Extract<OrchestrationCommand, { type: "thread.session.set" }>;

const seedProjectThreadAndSession = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = SEED_AT;
    const instanceId = ProviderInstanceId.make("codex");
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("stop-preserve-project-create"),
      projectId: PROJECT_ID,
      title: "Stop Preserve Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model: "gpt-5-codex" },
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("stop-preserve-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Stop Preserve Thread",
      modelSelection: { instanceId, model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
    // The session the stop will read: it CARRIES a banner. Seeded "stopped"
    // so the handler's providerService.stopSession pre-step is skipped (this
    // harness has no live provider binding) and the write under test — the
    // carried-over session set — runs unconditionally.
    yield* harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("stop-preserve-session-seed"),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "stopped",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: BANNER,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

it.live(
  "the reactor's stop path declares preserveLastError — its stale read can never erase a racing banner",
  () => {
    const recorded: OrchestrationCommand[] = [];
    return Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({
        onEngineCommand: (command) => {
          recorded.push(command);
        },
      }),
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectThreadAndSession(harness);
          recorded.length = 0;

          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("stop-preserve-stop"),
            threadId: THREAD_ID,
            createdAt: STOP_AT,
          });

          // The reactor processed the stop-request event and dispatched its
          // session write — observable only at the COMMAND level (the flag is
          // resolved away in the emitted event).
          const stopWrite = yield* Effect.gen(function* () {
            while (true) {
              const found = recorded.find(
                (command): command is SessionSetCommand =>
                  command.type === "thread.session.set" &&
                  command.threadId === THREAD_ID &&
                  command.session.status === "stopped",
              );
              if (found !== undefined) return found;
              yield* Effect.sleep("10 millis");
            }
          }).pipe(Effect.timeout("10 seconds"));

          assert.strictEqual(
            stopWrite.preserveLastError,
            true,
            "the stop's carried-over lastError is declared preserve — the decider re-resolves it",
          );
          assert.isUndefined(
            stopWrite.preserveActiveTurnId,
            "activeTurnId is an intentional clear — never preserved on stop",
          );
          assert.isNull(stopWrite.session.activeTurnId);
          assert.strictEqual(stopWrite.session.lastError, BANNER);

          // Projected outcome: the reactor's write landed (same updatedAt as
          // the captured command) with the banner intact. NOTE: without a
          // racing writer this holds for the carried value too — the
          // DISCRIMINATING pin is the command flag above; the preserve
          // RESOLUTION itself is pinned in sessionSetPreserveModes.test.ts.
          const thread = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.status === "stopped" &&
              entry.session.updatedAt === stopWrite.session.updatedAt,
          );
          assert.strictEqual(thread.session?.lastError, BANNER);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer));
  },
);
