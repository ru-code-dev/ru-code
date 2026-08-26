// ru-code (agentic-flow wave, ap-final T2): A STOP THAT DID NOT HAPPEN MUST SAY SO.
//
// The reactor already owes the user an answer — `processTaskStopRequested`
// (`ProviderCommandReactor.ts:1436-1452`) wraps the provider call in
// `Effect.catchCause` and appends a `provider.task.stop.failed` activity
// ("Could not stop the agent"). That row is the ONLY feedback a failed stop has,
// because the button fires `stopTask` with `{ reportFailure: false }`
// (`AgentStopButton.tsx:39`) and `reportAtomCommandResult`
// (`client-runtime/state/runtime.ts:401-413`) then renders nothing at all — not
// even a console warning.
//
// So a stop the adapter silently reports as SUCCESS is a stop nobody will ever
// hear about. `QwenAdapter.stopBackgroundTask` had two such paths:
//
//   1. no ACP session id ⇒ `return` (`:5482`). We never sent the cancel, and we
//      told the reactor it went fine.
//   2. qwen answered `{cancelled:false, reason:"not_found"}` — it has no such
//      task in this session's registry (`acpAgent.ts:9408-9415`) — and that was
//      a debug log and nothing else.
//
// `not_running` is a DIFFERENT answer and stays a no-op: qwen returns it for a
// task that already settled (`acpAgent.ts:9409`, `reason = task ? 'not_running'
// : 'not_found'`), the row is already showing its real terminal, and the
// reactor's own comment says a refusal like that is not a failure. Only
// `not_found` means "the thing you pressed stop on is not there" — which is
// exactly the state the user is complaining about when they say the click did
// nothing. These specs pin BOTH directions so a fix cannot over-correct.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../config.ts";
import { makeBackgroundAdapter, runningTaskEntry } from "./backgroundHarness.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-stopfail-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const TOOL_CALL_ID = "call_bf3a91c2";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "3c7d90fe");
/** An id qwen's registry has never heard of — `reason: "not_found"`. */
const STRANGER_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "deadbeef");

const makeScript = (backgroundTasks: FakeBackgroundTasksOptions): FakeAcpScript => ({
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
});

const launched = (
  threadId: ThreadId,
  entries: QwenAgentTaskEntry[],
  cancels: Array<{ taskId: string; taskKind: string }>,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    assert.isDefined(adapter.stopBackgroundTask, "the qwen adapter must expose a per-task stop");
    return { adapter, entries, cancels };
  });

it.live("a cancel qwen answers `not_found` FAILS — it can never be reported as a stop", () => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
  ];
  const cancels: Array<{ taskId: string; taskKind: string }> = [];
  const backgroundTasks: FakeBackgroundTasksOptions = {
    entries,
    onCancel: (params) => {
      cancels.push(params);
    },
  };
  return Effect.gen(function* () {
    const threadId = ThreadId.make("qwen-bg-stopfail-notfound");
    const { adapter } = yield* launched(threadId, entries, cancels);

    // The row on screen says running; qwen's registry has no such task. The
    // user presses the square and today gets absolute silence.
    const outcome = yield* Effect.exit(adapter.stopBackgroundTask!(threadId, STRANGER_ID));

    assert.deepStrictEqual(
      cancels,
      [{ taskId: STRANGER_ID, taskKind: "agent" }],
      "the cancel must still be attempted — the failure is about the ANSWER, not the send",
    );
    assert.isTrue(
      Exit.isFailure(outcome),
      "qwen said `cancelled:false reason:not_found` and the adapter reported SUCCESS: the " +
        "reactor's `provider.task.stop.failed` row (ProviderCommandReactor.ts:1440-1449) " +
        "therefore never fires, and the button fires with `reportFailure:false` " +
        "(AgentStopButton.tsx:39) — so the user pressed stop, nothing stopped, and nothing " +
        "anywhere said a word",
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(fakeAcpSpawnerLayer(makeScript(backgroundTasks)), testServices),
    ),
  );
});

it.live(
  "a cancel qwen answers `not_running` stays a NO-OP — a settled row is not a failure",
  () => {
    const entries: QwenAgentTaskEntry[] = [
      {
        ...runningTaskEntry({
          id: TASK_ID,
          description: DESCRIPTION,
          subagentType: SUBAGENT_TYPE,
          toolUseId: TOOL_CALL_ID,
        }),
        status: "completed",
      },
    ];
    const cancels: Array<{ taskId: string; taskKind: string }> = [];
    const backgroundTasks: FakeBackgroundTasksOptions = {
      entries,
      onCancel: (params) => {
        cancels.push(params);
      },
    };
    return Effect.gen(function* () {
      const threadId = ThreadId.make("qwen-bg-stopfail-notrunning");
      const { adapter } = yield* launched(threadId, entries, cancels);

      const outcome = yield* Effect.exit(adapter.stopBackgroundTask!(threadId, TASK_ID));

      assert.deepStrictEqual(cancels, [{ taskId: TASK_ID, taskKind: "agent" }]);
      assert.isTrue(
        Exit.isSuccess(outcome),
        "qwen's `not_running` is the documented idempotent no-op (acpAgent.ts:9409, " +
          "ProviderAdapter.ts:89-92): the task already settled and the row already shows its " +
          "real terminal. Turning THIS into a failure would put 'Could not stop the agent' on " +
          "screen every time a stop races the agent's own completion",
      );
    }).pipe(
      Effect.provide(
        Layer.provideMerge(fakeAcpSpawnerLayer(makeScript(backgroundTasks)), testServices),
      ),
    );
  },
);

// WHAT THIS FILE DELIBERATELY DOES NOT PIN, and why — the M32/MT5 precedent of
// this wave (measured defence in depth, documented in place rather than dressed
// up as a reproduction).
//
// `stopBackgroundTask`'s OTHER swallow was `if (sessionId === undefined) return;`
// (QwenAdapter.ts:5482): a cancel never sent, reported as a success. It is now a
// failure like the two above — but NO v0.21.1 wire can reach it, and I could not
// honestly write a spec that forces it. `acpSessionIdOf` (`:1406-1407`) reads the
// id out of `ctx.session.resumeCursor`, and the ctx is CONSTRUCTED with that
// cursor already filled from `session/new`'s own answer (`:3216-3235`, `sessionId:
// started.sessionId`) — so a context that exists at all has an id, by
// construction. My first draft of this spec asserted the opposite and went red
// for the wrong reason (`startSession` had already banked the cursor); it is
// recorded here rather than quietly repaired. The guard is kept because a
// silently-successful un-sent request is never the right default, not because
// anything observed it.
