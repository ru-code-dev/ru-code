// ru-code (cli-reload): step 3 of the reload — the qwen sweep, run at RUNTIME by the REAL
// reload engine, through the real write path (engine dispatch → event store → projection).
//
// What it proves, and why each half matters:
//   · B-G1 — the closing rows carry the RELOAD wording, not "a server restart". The boot
//     constants are untouched: the same seeded history swept by the BOOT entry still says
//     "server restart", so the parameterisation did not rewrite the boot contract;
//   · B.2  — nothing in the sweep is boot-only. `CliReloadEngine.reload` is what runs it here,
//     on a live server, and every dangling row the previous work left is closed;
//   · R4   — a live-claiming session row is reset to `stopped` with `activeTurnId` cleared and
//     the error banner PRESERVED (`preserveLastError`), exactly like a Stop.
//
// The dangling rows are SEEDED through the engine rather than produced by a live parked
// approval on purpose: which writer closes a parked request during a stop is a documented race
// (research B-G4), and a spec that asserts the wording must not depend on who wins it. The live
// parked-approval path is covered end to end by ru-code/e2e/tests-core/cliReload.e2e.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  defaultInstanceIdForDriver,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeOrchestrationIntegrationHarness } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import * as ProviderSessionRuntime from "../../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CliReloadEngine } from "../../cli-reload/CliReloadService.ts";
import { CliReloadHostLayer } from "../../cli-reload/cliReloadWiring.ts";
import { resetCliSpawnSchedulerForTests } from "../../cli-reload/cliSpawnScheduler.ts";
import { resetCliReloadRuntimeForTests } from "../../cli-reload/reloadRuntime.ts";
import {
  CLI_RELOAD_SWEEP_TEXTS,
  RELOAD_CANCELLED_APPROVAL_TEXT,
  RELOAD_CANCELLED_USER_INPUT_TEXT,
  RELOAD_INTERRUPTED_COMPACTION_TEXT,
} from "../../cli-reload/sweepCopy.ts";
import {
  CANCELLED_APPROVAL_TEXT,
  planQwenBootSweepRows,
  QWEN_BOOT_SWEEP_TEXTS,
} from "../../startup/qwenBootSweep.ts";

const QWEN = ProviderDriverKind.make("qwen");
const PROJECT = ProjectId.make("cli-reload-sweep-project");
const THREAD = ThreadId.make("cli-reload-sweep-thread");
const TASK_ID = `${CONTEXT_COMPACTION_TASK_PREFIX}reload-1`;
const TURN = TurnId.make("cli-reload-sweep-turn");
const AT = "2026-03-01T00:00:00.000Z";
const BANNER = "qwen exited with code 1";

let nextActivityId = 0;
const makeActivity = (
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(`cli-reload-seed-${nextActivityId++}`),
  createdAt: AT,
  kind,
  summary: kind,
  tone: "info",
  payload,
  turnId: null,
});

const summariesOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: string,
): ReadonlyArray<string> => activities.filter((row) => row.kind === kind).map((row) => row.summary);

it.live("the reload sweeps every dangling row with RELOAD wording and stops the session", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    (harness) =>
      Effect.gen(function* () {
        resetCliReloadRuntimeForTests();
        resetCliSpawnSchedulerForTests();
        const instanceId = defaultInstanceIdForDriver(QWEN);
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cli-reload-sweep-project-create"),
          projectId: PROJECT,
          title: "CLI Reload Sweep Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "m" },
          createdAt: AT,
        });
        yield* harness.engine.dispatch({
          type: "thread.create",
          chatViewMode: null,
          commandId: CommandId.make("cli-reload-sweep-thread-create"),
          threadId: THREAD,
          projectId: PROJECT,
          title: "CLI Reload Sweep Thread",
          modelSelection: { instanceId, model: "m" },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: AT,
        });

        // Exactly the three states the owner named — a parked approval, a parked question and
        // an open compaction row — plus the live-claiming session row behind them.
        const seeded: ReadonlyArray<OrchestrationThreadActivity> = [
          makeActivity("approval.requested", { requestId: "req-a", requestKind: "command" }),
          makeActivity("user-input.requested", { requestId: "req-q" }),
          makeActivity("task.progress", { taskId: TASK_ID, detail: "Compacting context…" }),
        ];
        for (const [index, activity] of seeded.entries()) {
          yield* harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`cli-reload-sweep-seed-${index}`),
            threadId: THREAD,
            activity,
            createdAt: AT,
          });
        }
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cli-reload-sweep-seed-session"),
          threadId: THREAD,
          session: {
            threadId: THREAD,
            status: "running",
            providerName: "qwen",
            runtimeMode: "approval-required",
            activeTurnId: TURN,
            lastError: BANNER,
            updatedAt: AT,
          },
          createdAt: AT,
        });

        // The REAL engine, over the harness's own services — the exact layer ws.ts provides.
        const base = Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, harness.sql),
          Layer.succeed(ProjectionSnapshotQuery, harness.snapshotQuery),
          Layer.succeed(OrchestrationEngine.OrchestrationEngineService, harness.engine),
          NodeServices.layer,
        );
        yield* Effect.gen(function* () {
          // The sweep is scoped to qwen-KIND bindings (qwenBootSweep.ts:387-389), which live
          // in the runtime-binding repository — the row a real session start writes. Seed it
          // through the production facade, not by touching the table.
          const directory = yield* ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: THREAD,
            provider: QWEN,
            providerInstanceId: instanceId,
            status: "running",
          });
          const cliReload = yield* CliReloadEngine;
          yield* cliReload.reload;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              CliReloadHostLayer.pipe(Layer.provide(base)),
              ProviderSessionDirectoryLive.pipe(
                Layer.provide(ProviderSessionRuntime.layer),
                Layer.provide(base),
              ),
            ),
          ),
          Effect.orDie,
        );

        // The sweep writes through the ordinary engine dispatch, so the projection converges
        // asynchronously — wait on the terminal fact, never a sleep.
        const thread = yield* harness.waitForThread(
          THREAD,
          (candidate) => candidate.session?.status === "stopped",
        );

        assert.deepStrictEqual(
          summariesOf(thread.activities, "approval.resolved"),
          [RELOAD_CANCELLED_APPROVAL_TEXT],
          "the parked approval was closed with the RELOAD wording",
        );
        assert.deepStrictEqual(
          summariesOf(thread.activities, "user-input.resolved"),
          [RELOAD_CANCELLED_USER_INPUT_TEXT],
          "the parked question was closed with the RELOAD wording",
        );
        assert.deepStrictEqual(
          summariesOf(thread.activities, "task.completed"),
          [RELOAD_INTERRUPTED_COMPACTION_TEXT],
          "the open compaction row was closed with the RELOAD wording",
        );
        const completed = thread.activities.find((row) => row.kind === "task.completed");
        assert.deepStrictEqual(completed!.payload, {
          taskId: TASK_ID,
          status: "stopped",
          detail: RELOAD_INTERRUPTED_COMPACTION_TEXT,
        });
        assert.isFalse(
          thread.activities.some((row) => row.summary.includes("server restart")),
          "a reload must never tell the user the server restarted",
        );

        // R4 — the session row reads like a Stop, and the banner survives.
        assert.strictEqual(thread.session?.activeTurnId ?? null, null, "active turn cleared");
        assert.strictEqual(thread.session?.lastError, BANNER, "the error banner is preserved");
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("the boot copy is untouched: the same history swept at boot still says 'server restart'", () => {
  const activities: ReadonlyArray<OrchestrationThreadActivity> = [
    makeActivity("approval.requested", { requestId: "req-a", requestKind: "command" }),
  ];
  assert.deepStrictEqual(
    planQwenBootSweepRows(THREAD, activities).map((row) => row.summary),
    [CANCELLED_APPROVAL_TEXT],
    "the DEFAULT (boot) wording is what a caller passing no texts still gets",
  );
  assert.deepStrictEqual(
    planQwenBootSweepRows(THREAD, activities, QWEN_BOOT_SWEEP_TEXTS).map((row) => row.summary),
    [CANCELLED_APPROVAL_TEXT],
  );
  assert.deepStrictEqual(
    planQwenBootSweepRows(THREAD, activities, CLI_RELOAD_SWEEP_TEXTS).map((row) => row.summary),
    [RELOAD_CANCELLED_APPROVAL_TEXT],
  );
});
