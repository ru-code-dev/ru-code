// ru-code (agentic-flow wave, live-issues T3): A RESUMED BACKGROUND AGENT'S ROW
// MUST COME BACK TO LIFE.
//
// The defect (reproduced 2026-08-27): a COMPLETED background agent that qwen
// hot-continues via `send_message` keeps running for real while its panel row
// reads "Completed" forever — and, being settled, it also loses its stop
// control. Three independent latches, any one sufficient:
//   1. `diffQwenBackgroundTasks` skips a settled task outright
//      (backgroundPoll.ts `if (previous.settled) continue;`);
//   2. the poll FIBER has already stopped — `backgroundPollTick` returns done on
//      `allTerminal` and the loop breaks (QwenAdapter.ts:1595, :1610-1611) — so
//      nothing is watching the registry at all;
//   3. `ctx.backgroundMeta.delete(...)` (:1591) has dropped the row's title.
//
// qwen's own lifecycle says this transition is real and expected:
// `'completed' → 'running'` via `restartCompletedAgent` (background-tasks.ts:724-748,
// research §16.1), reached from `send_message`'s resident branch
// (send-message.ts:150-158 → `registry.continueResidentAgent` →
// `residentController.continue`, agent.ts:3597-3625) or its cold-revive branch
// (`reviveCompletedBackgroundAgent`).
//
// THE ORDERING THIS SPEC MODELS IS THE PINNED ONE, and it is what makes the fix
// race-free: all three success paths flip the registry entry to `running`
// SYNCHRONOUSLY, before `execute()` returns — the resident path refuses unless
// `restarted.status === 'running'` (agent.ts:3618-3625), the revive path carries
// qwen's own comment "the status flip below is await-free"
// (background-agent-resume.ts:642), the paused path per research §15.4. So the
// snapshot is flipped BEFORE the resume result frame is emitted here, exactly as
// on the wire.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../config.ts";
import {
  collectBackgroundEvents,
  makeBackgroundAdapter,
  runningTaskEntry,
} from "./backgroundHarness.ts";
import type { FakeAcpScript, FakeBackgroundTasksOptions } from "./fakeAcpCore.ts";
import { fakeAcpSpawnerLayer } from "./fakeAcpSpawner.ts";
import { qwenBackgroundAgentId, type QwenAgentTaskEntry } from "./qwen021BackgroundAgents.ts";

const testServices = ServerConfig.layerTest(process.cwd(), { prefix: "ru-code-bg-resume-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const TOOL_CALL_ID = "call_1a2b3c4d";
const RESUME_CALL_ID = "call_sendmsg01";
const SUBAGENT_TYPE = "general-purpose";
const DESCRIPTION = "Audit the config";
const TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "5e6f7a8b");
const STRANGER_TASK_ID = qwenBackgroundAgentId(SUBAGENT_TYPE, "deadbeef");

const makeScript = (
  entries: QwenAgentTaskEntry[],
  resume: { readonly kind?: "resumed" | "continued" | "revived"; readonly wrongTaskId?: string },
) => {
  const backgroundTasks: FakeBackgroundTasksOptions = { entries };
  let promptIndex = 0;
  const script: FakeAcpScript = {
    dialect: "v2",
    onPrompt: (steps) => {
      promptIndex += 1;
      if (promptIndex === 1) {
        steps
          .emitBackgroundLaunch({
            toolCallId: TOOL_CALL_ID,
            agentId: TASK_ID,
            subagentName: SUBAGENT_TYPE,
            taskDescription: DESCRIPTION,
          })
          .emitText("launched")
          .respondOk();
        return;
      }
      steps
        .emitBackgroundResume({
          toolCallId: RESUME_CALL_ID,
          taskId: resume.wrongTaskId ?? TASK_ID,
          ...(resume.kind !== undefined ? { kind: resume.kind } : {}),
        })
        .emitText("woken")
        .respondOk();
    },
    backgroundTasks,
  };
  return script;
};

const drive = (
  label: string,
  resume: { readonly kind?: "resumed" | "continued" | "revived"; readonly wrongTaskId?: string },
  check: (input: {
    readonly progressAfterResume: ReadonlyArray<string | undefined>;
    readonly taskIds: ReadonlyArray<string>;
  }) => void,
) => {
  const entries: QwenAgentTaskEntry[] = [
    runningTaskEntry({
      id: TASK_ID,
      description: DESCRIPTION,
      subagentType: SUBAGENT_TYPE,
      toolUseId: TOOL_CALL_ID,
    }),
    // A task THIS THREAD NEVER LAUNCHED, live in qwen's registry the whole time
    // (another incarnation's agent; §16.5 keeps the registry per session but a
    // reload rehydrates rows we never saw). It exists so that a re-arm which
    // adopted strangers would be caught emitting a row for it.
    runningTaskEntry({
      id: STRANGER_TASK_ID,
      description: "Someone else's work",
      subagentType: SUBAGENT_TYPE,
    }),
  ];
  const script = makeScript(entries, resume);
  return Effect.gen(function* () {
    const adapter = yield* makeBackgroundAdapter();
    const view = yield* collectBackgroundEvents(adapter);
    const threadId = ThreadId.make(`bg-resume-${label}`);
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" });
    yield* adapter.sendTurn({ threadId, input: "launch an agent" });
    yield* view.waitFor("the launch opened a row", () => view.taskStarted().length > 0);

    // The agent finishes: the row settles and the poll reaches `allTerminal`,
    // so its fiber stops. Everything after this point has no watcher.
    entries[0] = { ...entries[0]!, status: "completed" };
    yield* view.waitFor("the row settled", () => view.taskCompleted().length > 0);
    // THE POLL MUST ACTUALLY BE DEAD before the resume, or this spec proves
    // only half the defect. `backgroundPollTick` stops on
    // `allTerminal && backgroundPendingChat.size === 0` (QwenAdapter.ts:1595),
    // so the fiber survives until the completion has been SAID in chat. Wait
    // for qwen's own completion sentence, then give the loop its own tick to
    // observe the now-empty queue and break (:1610-1611).
    yield* view.waitFor("the completion reached the chat", () =>
      view.chatText().includes("completed."),
    );
    yield* Effect.sleep(300);
    const progressBefore = view.taskProgress().length;

    // qwen flips the entry back FIRST (synchronously, inside execute()) …
    entries[0] = {
      ...entries[0]!,
      status: "running",
      recentActivities: [{ name: "write_file", description: "/c.ts", at: 1_699_999_300_000 }],
    };
    // … and only then does the tool result reach the wire.
    yield* adapter.sendTurn({ threadId, input: "wake the agent" });
    // Ten poll ticks at the 60ms test cadence: long enough that a running poll
    // could not miss the flip, so an empty result means nothing is watching.
    yield* Effect.sleep(600);

    const after = view.taskProgress().slice(progressBefore);
    check({
      progressAfterResume: after.map((event) => event.payload.status),
      taskIds: [...new Set(after.map((event) => event.payload.taskId))],
    });
    yield* view.stop;
  }).pipe(
    Effect.provide(fakeAcpSpawnerLayer(script).pipe(Layer.provideMerge(testServices))),
    Effect.scoped,
  );
};

it.live("a RESIDENT completed agent, continued via send_message, re-opens its row", () =>
  drive("continued", { kind: "continued" }, ({ progressAfterResume, taskIds }) => {
    assert.include(
      progressAfterResume,
      "running",
      "the row never came back to life: qwen is running this agent again and the panel " +
        "still reads Completed (and, being settled, shows no stop control either)",
    );
    assert.deepStrictEqual(taskIds, [TASK_ID], "the resume must reuse the row, not open a new one");
  }),
);

it.live("a REVIVED completed agent re-opens its row too — the cold path", () =>
  drive("revived", { kind: "revived" }, ({ progressAfterResume }) => {
    assert.include(progressAfterResume, "running");
  }),
);

it.live("a resume naming a task we never tracked opens nothing", () =>
  drive("untracked", { wrongTaskId: STRANGER_TASK_ID }, ({ progressAfterResume }) => {
    // The poll ignores snapshot rows it never saw launched (backgroundPoll.ts's
    // `if (previous === undefined) continue`), and re-arming for a stranger
    // would put work on the panel this thread never started.
    assert.deepStrictEqual(progressAfterResume, []);
  }),
);

it.live("the stranger in the snapshot is never adopted by a resume", () =>
  drive("stranger", { wrongTaskId: STRANGER_TASK_ID }, ({ taskIds }) => {
    assert.notInclude(
      taskIds,
      STRANGER_TASK_ID,
      "a resume adopted a task this thread never launched — the panel would show " +
        "work the user never started here",
    );
  }),
);
