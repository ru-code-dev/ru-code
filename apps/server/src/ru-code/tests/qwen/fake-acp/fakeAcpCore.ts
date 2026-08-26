// ru-code: transport-agnostic fake ACP **agent** for the error-engine tests. It
// speaks the REAL ndJSON-RPC wire contract by reusing effect-acp's own
// `AcpAgent` (so the port exercises the same protocol machinery a live qwen
// would). A test supplies a per-prompt script via the `PromptSteps` DSL; the
// agent interprets it to reproduce each error class from the qwen error truth
// table (RPC error, malformed frame, broken pipe, process exit, …).
//
// The in-memory shell (`fakeAcpSpawner.ts`) drives this core for unit tests: it
// backs the fake agent with in-memory queues so the REAL QwenAdapter runs
// unchanged over it — no real process, no real pipe, no wall-clock.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import type * as Stdio from "effect/Stdio";
import * as AcpAgent from "effect-acp/agent";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

// ru-code (agents wave, phase 2): the qwen 0.21.1 emitter transcription. Every
// v2 frame this file puts on the wire is built THERE, so a shape can only be
// wrong in one place — and that place is annotated with the qwen src line it
// was copied from.
// ru-code (mid-turn wave, phase 2): the drain CALLER transcription — every
// constant and rule the fake enforces below is defined and pinned there.
import {
  QWEN_MID_TURN_DRAIN_METHOD,
  QWEN_MID_TURN_DRAIN_TIMEOUT_MS,
  qwenDrainParamsFor,
  qwenIsPermanentDrainFailure,
  qwenIsValidDrainResponse,
  qwenReadDrainedContent,
  qwenReadDrainedTexts,
  type QwenDrainCallSite,
} from "./qwen021MidTurnDrain.ts";
import {
  qwenAgentSpawnPermissionRequest,
  qwenEmitAgentMessage,
  qwenEmitAgentPreparingStart,
  qwenEmitAgentThought,
  qwenEmitGoalStatus,
  qwenEmitGoalTerminal,
  qwenEmitPlan,
  qwenEmitPreparationDiscarded,
  qwenEmitStopHookLoop,
  qwenEmitToolCallError,
  qwenEmitToolCallResult,
  qwenEmitToolCallStart,
  qwenEmitUsageMetadata,
  type QwenSubagentMeta,
} from "./qwen021Frames.ts";
// ru-code (agentic-flow wave, P2): the background-agent transcription. Every
// background byte the fake puts on the wire — and every rule it applies to a
// poll or a cancel — is defined THERE, pinned to its qwen src line.
import {
  QWEN_BACKGROUND_END_TURN_METHOD,
  QWEN_SESSION_TASKS_METHOD,
  QWEN_SESSION_TASK_CANCEL_METHOD,
  QWEN_TASK_KINDS,
  QwenSessionTaskCancelRequest,
  QwenSessionTasksRequest,
  qwenBackgroundDisplayLine,
  qwenBackgroundEndTurnParams,
  qwenBuildSessionTasksStatus,
  qwenEmitBackgroundLaunch,
  qwenEmitSendMessageResume,
  qwenEmitBackgroundNotificationDisplay,
  qwenEmitBackgroundNotificationResponse,
  qwenEmitOrphanParentChunk,
  qwenPruneTerminalEntries,
  qwenSessionTaskCancelResponse,
  type QwenAgentTaskEntry,
  type QwenAgentTaskLifecycleStatus,
} from "./qwen021BackgroundAgents.ts";

export type { QwenSubagentMeta, QwenAgentTaskEntry, QwenAgentTaskLifecycleStatus };

/** ru-code (v2): the three empty-text `_meta`-only frames, MessageEmitter.ts:37-86. */
export type QwenSignalFrame =
  | {
      readonly kind: "stopHookLoop";
      readonly iterationCount: number;
      readonly reasons: ReadonlyArray<string>;
      readonly stopHookCount: number;
    }
  | {
      readonly kind: "goalTerminal";
      readonly terminal: {
        readonly kind: "achieved" | "aborted" | "failed";
        readonly condition: string;
        readonly iterations: number;
        readonly durationMs: number;
        readonly lastReason?: string;
      };
    }
  | {
      readonly kind: "goalStatus";
      readonly status: {
        readonly kind: "set" | "achieved" | "cleared" | "failed" | "aborted" | "checking";
        readonly condition: string;
        readonly iterations?: number;
      };
    };

/** The session id the fake hands back from `session/new` (and accepts on prompt). */
export const FAKE_SESSION_ID = "fake-acp-session";

/**
 * ru-code (mid-turn wave): what the HOST answered to an agent→host ext REQUEST.
 * `code` is the JSON-RPC error code — `-32601` is the one that matters, since it
 * is what our client emits today for an unregistered ext method
 * (effect-acp `client.ts:397` → `errors.ts:303-305`) and what qwen treats as a
 * permanent, one-strike disable of the drain (Session.ts:4776-4783).
 */
export type FakeExtRequestOutcome =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "error"; readonly code: number | undefined; readonly message: string };

/**
 * ru-code (mid-turn wave, phase 2): what ONE modelled drain did, as the AGENT
 * saw it. This is the observation surface a spec asserts on — it is deliberately
 * the agent's view, not the host's, because the contract under test is "what
 * does qwen end up believing / feeding the model", not "what did we intend".
 */
export interface FakeMidTurnDrainObservation {
  /** Which of qwen's five call sites this drain modelled. */
  readonly callSite: QwenDrainCallSite;
  /** True when the drain was SKIPPED because the channel is permanently off. */
  readonly skipped: boolean;
  /** The raw host answer. `undefined` when skipped. */
  readonly outcome: FakeExtRequestOutcome | undefined;
  /**
   * The texts the model would see for THIS drain, post-cap and post-prefix —
   * i.e. `qwenFoldDrainedTexts`'s drained half. Message boundaries are preserved
   * as separate entries, each independently prefixed.
   */
  readonly deliveredTexts: ReadonlyArray<string>;
  /**
   * ru-code (phase 4, M1/SB1): the RAW ContentBlock arrays, one entry per
   * drained item. `deliveredTexts` collapses each item to its prefixed display
   * text, which cannot see an image block at all — that blindness is what let
   * attachments be dropped while the mark said delivered.
   */
  readonly deliveredContent: ReadonlyArray<ReadonlyArray<AcpSchema.ContentBlock>>;
  /** `isValidMidTurnDrainResponse` — gates the todoStopGuard ONLY. */
  readonly reliable: boolean;
  /** Strict `=== true` read of the host's `hasQueuedPrompt`. */
  readonly hasQueuedPrompt: boolean;
  /** Consecutive timeout strikes AFTER this drain (resets to 0 on success). */
  readonly timeoutStrikes: number;
  /** True once the channel has latched permanently off for the session. */
  readonly permanentlyDisabled: boolean;
}

/** ru-code (mid-turn wave): the drain knob. ABSENT ⇒ the fake NEVER polls. */
export interface FakeMidTurnDrainOptions {
  /**
   * Every modelled drain, in order. The single assertion surface for the
   * contract specs.
   */
  readonly onDrain?: (observation: FakeMidTurnDrainObservation) => void;
  /**
   * Test-speed override for `QWEN_MID_TURN_DRAIN_TIMEOUT_MS`. DEFAULTS to
   * qwen's real 2_000 — a spec only lowers it to keep a deliberate
   * three-strike test from costing six real seconds. Lowering it does not
   * change any other transcribed rule.
   */
  readonly timeoutMs?: number;
  /**
   * ru-code (phase 4b, SB6): force the OUTCOME of the Nth drain, bypassing the
   * host call, so the fake's OWN latch/strike machinery can be driven.
   *
   * Round 2's residual: eight unit specs pin the transcribed PREDICATES, and A6
   * drives a real `-32601` — but nothing connected the predicate to the fake's
   * runtime. Deleting the `qwenIsPermanentDrainFailure` block from the executor
   * left the whole matrix green, because every matrix spec asserts the values a
   * DISABLED latch also produces (`permanentlyDisabled: false`,
   * `timeoutStrikes: 0`).
   *
   * A real 2s stall cannot be produced through a responder that is synchronous
   * by construction, so the outcome is injected here instead — the rules under
   * test are the fake's reaction to it, not the transport.
   */
  readonly forceOutcomes?: ReadonlyArray<"method-not-found" | "timeout" | undefined>;
}

/**
 * ru-code (agentic-flow wave, P2): the BACKGROUND-AGENT knob.
 *
 * ABSENT (the default, and what every pre-existing suite gets) means the fake
 * answers NEITHER `qwen/status/session/tasks` NOR
 * `qwen/control/session/task/cancel` — a host polling such a child gets `-32601`
 * from its own client (effect-acp client.ts:390-397), which is exactly what a
 * qwen 0.13.1 engine (no background feature at all, research §5) produces. That
 * is the strike-out path, and keeping it the DEFAULT is what stops a legacy
 * suite from silently acquiring a poll surface.
 */
export interface FakeBackgroundTasksOptions {
  /**
   * The live registry the fake serves. MUTABLE by the test between polls —
   * qwen's own `getAll()` returns the live Map entries, not clones
   * (research §14.1, object-identity), so mutating an entry here reproduces the
   * real "the next poll already sees it" semantics.
   */
  readonly entries: QwenAgentTaskEntry[];
  /** Fixed `now` for `runtimeMs` determinism (tasksSnapshot.ts:128 defaults it). */
  readonly now?: number;
  /** Fires on every served poll with the rows the 32-cap left behind. */
  readonly onPoll?: (served: ReadonlyArray<QwenAgentTaskEntry>) => void;
  /**
   * Fires on EVERY poll the host makes, answered or forced-to-fail. `onPoll`
   * cannot see a forced failure (there is nothing served), so a strike-out spec
   * has no other way to count attempts.
   */
  readonly onPollAttempt?: () => void;
  /** Fires on every cancel with the params received and the answer given. */
  readonly onCancel?: (
    params: { readonly taskId: string; readonly taskKind: string },
    response: Record<string, unknown>,
  ) => void;
  /**
   * Force the Nth poll (0-based) to REJECT with this JSON-RPC error instead of
   * answering. `undefined` at an index means "answer normally". Drives the
   * poller's strike-out rule, which no cooperative fake could otherwise reach.
   */
  readonly pollFailures?: ReadonlyArray<
    { readonly code: number; readonly message: string } | undefined
  >;
}

/** The failed `extRequest` exit's underlying ACP error, if it carries one. */
const readExtRequestFailure = (exit: Exit.Exit<unknown, AcpErrors.AcpError>): unknown =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const readExtRequestErrorCode = (
  exit: Exit.Exit<unknown, AcpErrors.AcpError>,
): number | undefined => {
  const error = readExtRequestFailure(exit);
  return error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "number"
      ? error.code
      : undefined
    : undefined;
};

const readExtRequestErrorMessage = (exit: Exit.Exit<unknown, AcpErrors.AcpError>): string => {
  const error = readExtRequestFailure(exit);
  if (error !== null && typeof error === "object" && "errorMessage" in error) {
    if (typeof error.errorMessage === "string") return error.errorMessage;
  }
  return String(error);
};

type StopReason = AcpSchema.PromptResponse["stopReason"];

/**
 * Transport-level controls the SHELL provides. These reach below the JSON-RPC
 * layer to reproduce wire failures the agent handler cannot express as a normal
 * response:
 *   - `writeRaw`        → emit a malformed frame   → client AcpProtocolParseError (C1)
 *   - `closeTransport`  → EOF + failed exit status  → client AcpTransportError    (C4)
 *   - `exit(code)`      → EOF + exit status `code`   → client AcpProcessExitedError (B1)
 */
export interface FakeAcpTransportControls {
  readonly writeRaw: (bytes: string) => Effect.Effect<void>;
  readonly closeTransport: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
}

/** Fluent recorder for a single `session/prompt`. Chainable; terminal ops end it. */
export interface PromptSteps {
  /**
   * Stream an assistant text chunk (`session/update` agent_message_chunk).
   *
   * ru-code (v2): `subagentMeta` tags the chunk as a CHILD's narration —
   * impossible at v1, where qwen dropped the tag before the wire
   * (SubAgentTracker.ts v0.13.1 `:267-280` passed no meta), and the reason our
   * attribution had to be a window heuristic. At v0.21.1 the tag is real
   * (SubAgentTracker.ts:304-310 → MessageEmitter.ts:137-150). Ignored under
   * dialect v1 so an existing suite cannot accidentally opt in.
   */
  emitText(text: string, subagentMeta?: QwenSubagentMeta): PromptSteps;
  /**
   * ru-code (sub-agents): the REAL qwen THOUGHT frame — `agent_thought_chunk`
   * with NO `_meta` at all. qwen emits it for the parent AND for a sub-agent;
   * the sub-agent variant loses its attribution at
   * qwen-code SubAgentTracker.ts:275 exactly like the text chunk, so it reaches
   * the wire indistinguishable from the parent's. Scripted so the flow test can
   * prove the chat never shows a child's thinking.
   */
  emitThought(text: string, subagentMeta?: QwenSubagentMeta): PromptSteps;
  /**
   * ru-code (v2 ONLY): one of qwen 0.21.1's SIGNAL FRAMES — an empty-text
   * `agent_message_chunk` whose entire payload is `_meta`
   * (MessageEmitter.ts:37-86). A host that switches only on `sessionUpdate`
   * and non-empty text never sees these at all. Under dialect v1 the step is a
   * no-op: qwen 0.13.1 had no such frames (`packages/core/src/goals/` does not
   * exist at that tag), so emitting one would be fiction.
   */
  emitSignalFrame(signal: QwenSignalFrame): PromptSteps;
  /**
   * ru-code (phase 4b, R-4): the PERMISSION-GATED spawn — the shape the product
   * produces in its DEFAULT runtime mode, and which no spec modelled before.
   *
   * `AgentTool.getDefaultPermission()` is `'ask'` (qwen agent.ts:1566-1568) and
   * `resolveQwenMode` never emits yolo/auto (QwenAdapter.ts:666-674), so in
   * `approval-required` the agent tool takes the permission path and
   * `SE:7861`'s `if (!didRequestPermission && !isTodoWriteTool)` SKIPS
   * `emitStart` — the spawn never reaches the wire as a `tool_call` at all. The
   * host sees a `session/request_permission` (whose `_meta` carries no
   * `provenance`), then the child's own frames, then the terminal
   * `tool_call_update` from `emitResult` (SE:8216).
   *
   * This step emits nothing by itself; it exists so a script can SAY that the
   * spawn was gated, keeping the intent legible where `.requestPermission(...)`
   * alone would look like an ordinary tool approval.
   */
  spawnGatedByPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps;
  /**
   * ru-code (agentic-flow wave, FIX ROUND 3): THE DEFAULT-MODE SPAWN WIRE, whole.
   *
   * The dialect's approval-mode variant, as one step, so a script cannot model
   * half of it: the PREPARING frame (which the real wire always sends first —
   * tool-call-preparation-tracker.ts:29-51) followed by the
   * `session/request_permission` that CARRIES THE ARGS in place of the
   * `emitStart` frame `Session.ts:7861` skips. Every byte of the request is
   * pinned on `qwenAgentSpawnPermissionRequest`.
   *
   * The other half of the axis is `emitToolCall` + `emitAgentPreparingStart`
   * (the AUTO_EDIT wire, where `Session.ts:7621-7628` auto-approves the `info`
   * confirmation and the args ride a `tool_call` instead). A spec that models
   * only that one is testing a mode the product does not default to.
   */
  emitAgentSpawnGated(input: {
    readonly callId: string;
    readonly description: string;
    readonly subagentType: string;
    readonly prompt?: string;
    /** Omit for qwen's own args rule to decide (see `qwenSpawnArgsRunInBackground`). */
    readonly runInBackground?: boolean;
    /** Defaults to true — the real wire always prepares first. */
    readonly preparing?: boolean;
  }): PromptSteps;
  /** ru-code(e2e): real wall-clock pause between steps — the stdio fake uses it to
   *  simulate qwen's spawn/think latency for the live browser harness. */
  sleep(ms: number): PromptSteps;
  /**
   * ru-code (agentic-flow wave, P1): park the script until the TEST opens the
   * gate. `sleep` is its non-deterministic cousin — every background spec in
   * this wave asserts on an INTERLEAVING (an orphan frame arriving while a real
   * turn's assistant segment is open; a poll landing between two turns), and a
   * wall-clock window makes the assertion a coin flip rather than a contract.
   * The gate is the test's own `Deferred`, so the ordering is by construction.
   */
  awaitGate(gate: Deferred.Deferred<void>): PromptSteps;
  /**
   * ru-code: like emitText but stamps running usage on the chunk under
   * `update._meta.usage.inputTokens` — exactly where qwen puts its live
   * promptTokenCount. Drives the adapter's live token-feed (thread.token-usage.updated).
   */
  emitTextWithUsage(text: string, inputTokens: number): PromptSteps;
  /**
   * ru-code: emit the REAL qwen usage frame. qwen does NOT put usage on streaming
   * text chunks — it emits a DEDICATED `agent_message_chunk` whose `content.text`
   * is `""` (empty), carrying `_meta.usage.*`, once per model-response stream after
   * the text loop (qwen-code MessageEmitter.ts:77-101 `emitUsageMetadata` with
   * text=''; Session.ts:341-348). This step reproduces that exact frame so the
   * live token-feed is tested against the shape qwen actually sends (unlike
   * emitTextWithUsage, whose non-empty text never co-occurs with usage in reality).
   */
  emitUsageChunk(inputTokens: number): PromptSteps;
  /**
   * ru-code: emit the REAL qwen TASK-LIST frame. qwen's `todo_write` tool routes
   * through PlanEmitter.emitPlan (qwen-code Session.ts:893-902), which sends a
   * `session/update` with `sessionUpdate:"plan"` and
   * `entries:[{content, priority:"medium", status}]` where status ∈
   * pending|in_progress|completed (qwen-code PlanEmitter.ts + types.ts:89-92).
   * This is the live task-list surface (distinct from exit_plan_mode approval).
   */
  emitPlan(entries: ReadonlyArray<{ content: string; status: string }>): PromptSteps;
  /**
   * ru-code: emit the REAL qwen `tool_call` frame. `_meta.toolName` always rides
   * along (qwen-code ToolCallEmitter.ts:64-80); `subagentMeta`, when given, adds
   * `{ parentToolCallId, subagentType }` — the exact bundle SubAgentTracker
   * attaches to every frame a sub-agent produces (SubAgentTracker.ts:70-75).
   */
  emitToolCall(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly title: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
    readonly kind?: AcpSchema.ToolKind;
    readonly rawInput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps;
  /**
   * ru-code: emit the REAL qwen `tool_call_update` frame (same `_meta` rules).
   * `rawOutput` is qwen's result display — for the `agent` tool that is the
   * AgentResultDisplay the adapter reads the final text and usage from
   * (qwen-code ToolCallEmitter.ts:144-147, tools.ts:486-512).
   */
  emitToolCallUpdate(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "completed" | "failed";
    readonly text?: string;
    readonly rawOutput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps;
  /**
   * ru-code (agentic-flow wave, P2): THE LYING LAUNCH FRAME — the wrapping
   * `agent` call's `tool_call_update` reported `status: 'completed'` at launch,
   * before the subagent has run a single turn (research §1.2). Its `rawOutput`
   * is an `AgentResultDisplay` with `status: 'background'` and NO task id
   * anywhere (tools.ts:630-658).
   *
   * ru-code (agentic-flow wave, FIX ROUND 1): `agentId` is REQUIRED and is the real registry id —
   * `${subagentName}-<random8>` (agent.ts:2839/:2842; the ACP path leaves
   * `this.callId` undefined — see `qwenBackgroundAgentId`). It is deliberately
   * unrelated to `toolCallId`, so a host that reconstructs the id from the frame
   * instead of reading `task_id:` out of the launch prose cannot pass.
   *
   * Deliberately NOT expressible as `emitToolCallUpdate({rawOutput: …})`: the
   * whole point is that the bytes come from the transcription, so a fixture
   * cannot drift from `qwenBackgroundLaunchResultDisplay`.
   */
  emitBackgroundLaunch(input: {
    readonly toolCallId: string;
    readonly agentId: string;
    readonly subagentName: string;
    readonly taskDescription: string;
    readonly taskPrompt?: string;
    /**
     * ru-code (agentic-flow wave, FIX ROUND 2): emit the PREPARING frame first.
     * Defaults to TRUE because a real launch always does. A script that has
     * already put this call's opening frame on the wire itself (the fork case,
     * whose args classify foreground) sets it false so the sequence stays in
     * qwen's order instead of replaying an opening after the fact.
     */
    readonly preparing?: boolean;
  }): PromptSteps;
  /**
   * ru-code (agentic-flow wave, P2): an ORPHAN parent chunk emitted INSIDE the
   * prompt — an ordinary untagged `agent_message_chunk`. Used by the corruption
   * repro to prove the splice happens against a live turn's own buffer.
   */
  /**
   * ru-code (agentic-flow wave, FIX ROUND 2): the REAL first frame of a
   * top-level agent spawn — `tool_call`, `phase: 'preparing'`, `rawInput: {}`,
   * `title: 'Agent'`. See `qwenEmitAgentPreparingStart` for the full pin chain
   * (tool-call-preparation-tracker.ts:29-51 → tool-call-emitter.ts:92-120 →
   * transcript-replay.ts:248-271).
   *
   * Emitted automatically by {@link emitBackgroundLaunch} — a real background
   * launch is a SEQUENCE, not one frame — and available standalone so a
   * foreground script can speak the same true opening.
   */
  emitAgentPreparingStart(toolCallId: string): PromptSteps;
  /**
   * ru-code (agentic-flow wave, live-issues T3): THE RESUME RESULT FRAME.
   *
   * `send_message` targeting a background task id is the ONLY resume trigger
   * that exists (research §15.2 2e). This emits its terminal tool result — the
   * frame that is guaranteed to arrive AFTER qwen has already flipped the
   * registry entry back to `running` (see `readQwenResumedTaskId`).
   */
  emitBackgroundResume(input: {
    readonly toolCallId: string;
    readonly taskId: string;
    readonly kind?: "resumed" | "continued" | "revived";
  }): PromptSteps;
  /**
   * ru-code (agentic-flow wave, FIX ROUND 3): THE DISCARD — the OTHER fate of a
   * preparing frame, and the one no fixture ever sent.
   *
   * `ToolCallPreparationTracker.discard` (`:66-92`) → `emitPreparationDiscarded`
   * (tool-call-emitter.ts:135-156): a `tool_call_update` with `status:'failed'`,
   * `content: []` and `_meta.preparationDiscarded`. It fires whenever a call the
   * model started emitting never reaches execution — a stream retry or model
   * fallback (`Session.ts:3054`, `includeResolved: true`), a stream error or a
   * user abort (`:3066`), or the tool loop's own cleanup sites (`:4023`, `:4087`,
   * `:5407`, `:5420`, `:5900`, `:5913`).
   *
   * The call NEVER HAPPENED: the tracker only ever holds calls whose args have
   * not been handed to tool execution (`pending`/`resolved`, `:18-22`), and
   * `finalizeToolCallPreparations` runs in the model stream's own `finally`
   * (`Session.ts:3062-3070`), i.e. before any tool runs. A retry may re-emit the
   * same callId afterwards, so the discard must poison nothing.
   */
  emitAgentPreparationDiscarded(toolCallId: string): PromptSteps;
  /**
   * ru-code (agentic-flow wave, FIX ROUND 3 ADDENDUM): `emitError`
   * (tool-call-emitter.ts:216-240) — the terminal frame of a call REFUSED or
   * failed BEFORE it produced a result.
   *
   * Every `earlyErrorResponse` path takes it (`Session.ts:7059`), and the
   * everyday one is the user pressing Reject on the spawn dialog, whose message
   * is qwen's own `Tool "<name>" was canceled by the user.` (`Session.ts:7702`).
   * Unlike `emitResult` it carries **no `rawOutput`** — there is no
   * `AgentResultDisplay`, because the agent never ran — and unlike the discard
   * frame it carries no `_meta.phase` either.
   */
  emitToolCallError(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly errorMessage: string;
  }): PromptSteps;
  emitOrphanChunk(text: string): PromptSteps;
  /**
   * ru-code: the SUB-AGENT variant of {@link emitUsageChunk} — same dedicated
   * empty-text agent_message_chunk, but tagged with the sub-agent bundle
   * (qwen-code SubAgentTracker.ts:247-259 → MessageEmitter.ts:77-101). The
   * thread's context meter must ignore it.
   */
  emitSubAgentUsageChunk(input: {
    readonly inputTokens: number;
    readonly parentToolCallId: string;
    readonly subagentType: string;
  }): PromptSteps;
  /**
   * ru-code: send an agent→client `session/request_permission` and AWAIT the client's
   * choice (the adapter parks it behind a Deferred until the user responds). Chainable —
   * drives the exit_plan_mode held-approval + ask-permission paths.
   */
  requestPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps;
  /**
   * ru-code: send an arbitrary agent→client ACP extension NOTIFICATION (no id).
   * Drives the adapter's `handleUnknownExtNotification` slash-command path (the
   * `_qwencode/slash_command` /compress feed). Chainable; fire-and-forget.
   */
  emitExtNotification(method: string, params: unknown): PromptSteps;
  /**
   * ru-code (mid-turn wave): send an agent→client ACP extension REQUEST (with an
   * id) and AWAIT the host's answer, mid-prompt — the direction qwen 0.21.1 uses
   * for `craft/drainMidTurnQueue` (Session.ts:4707,
   * `this.client.extMethod(MID_TURN_QUEUE_DRAIN_METHOD, {sessionId})`, where
   * `this.client` is the AgentSideConnection back to the HOST).
   *
   * The outcome is handed to `onOutcome` instead of being asserted here, because
   * a rejection is a legitimate result: a host with no responder registered
   * answers `-32601`, which qwen latches as a PERMANENT per-session disable
   * (Session.ts:4776-4783). The step never fails the prompt — it records and
   * continues, so a script can probe the responder and still finish its turn.
   */
  extRequest(
    method: string,
    params: unknown,
    onOutcome: (outcome: FakeExtRequestOutcome) => void,
  ): PromptSteps;
  /**
   * ru-code (mid-turn wave, phase 2): model ONE of qwen's mid-turn drains at
   * this point in the script — the agent calls the HOST's
   * `craft/drainMidTurnQueue` responder and applies qwen's own rules to the
   * answer (2s deadline, consecutive-timeout strikes, `-32601`/"method not
   * found" permanent latch, 10-item cap, per-message prefix). Every rule is
   * transcribed in `qwen021MidTurnDrain.ts` with its qwen src line.
   *
   * Requires `midTurnDrain` on the script; without it this step is a NO-OP, and
   * that is the point — the DEFAULT fake NEVER polls, exactly like a v0.13.1
   * engine (`QWEN_V1_POLLS_MID_TURN = false`). Existing suites therefore cannot
   * accidentally acquire a drain.
   *
   * `callSite` selects which of the five `#drainMidTurnInput` sites is being
   * modelled; it changes only the params shape (`todoStopGuardWatchQueuedPrompt`).
   * Defaults to the canonical every-turn one.
   */
  drainMidTurn(callSite?: QwenDrainCallSite): PromptSteps;
  /** Resolve the prompt with a stopReason (turn completes). Terminal. */
  respondOk(stopReason?: StopReason): void;
  /** Reply with a JSON-RPC error (qwen stays alive). Terminal. */
  respondError(code: number, message: string, data?: unknown): void;
  /** Write a malformed frame to the client (→ AcpProtocolParseError). Terminal. */
  writeRaw(bytes: string): void;
  /** Close the transport mid-prompt (→ AcpTransportError). Terminal. */
  closeTransport(): void;
  /** Exit the child with `code` (→ AcpProcessExitedError). Terminal. */
  exit(code: number): void;
}

export interface FakeAcpScript {
  /** Called once per `session/prompt`; build the response with the step DSL. */
  readonly onPrompt: (steps: PromptSteps) => void;
  /**
   * ru-code (agents wave, phase 2): which qwen WIRE DIALECT the fake speaks.
   *
   *   - "v1" (DEFAULT) — the 0.13.1-era shapes this harness was built against:
   *     `_meta` on tool calls only (`{toolName, parentToolCallId?, subagentType?}`),
   *     no `provenance`, untagged text/thought chunks, no signal frames.
   *   - "v2" — qwen 0.21.1, produced by the 1:1 emitter transcription in
   *     `qwen021Frames.ts`: `provenance` stamped on every tool call, subagent
   *     tags on text AND thought chunks, renamed usage keys
   *     (`cachedReadTokens`), and the empty-text signal frames.
   *
   * DEFAULTING TO v1 IS THE POINT: every suite that predates this knob keeps
   * asserting the exact bytes it was written against, so the v1 behavioural
   * specs stay the wave's regression anchor while v2 lands beside them. A
   * change here that alters a v1 frame is a phase-1 regression, not a phase-2
   * feature.
   */
  readonly dialect?: "v1" | "v2";
  /**
   * ru-code (mid-turn wave, phase 2): enable the modelled mid-turn drain.
   *
   * ABSENT (the default, and what every pre-existing suite gets) means the fake
   * NEVER calls the host's drain responder — the v0.13.1 no-polling engine,
   * which is also the fallback our turn-end flush must cover. `drainMidTurn()`
   * steps are inert without this.
   */
  readonly midTurnDrain?: FakeMidTurnDrainOptions;
  /**
   * ru-code (agentic-flow wave, P2): enable the modelled background-agent
   * surface (poll + cancel). ABSENT ⇒ both ext methods reject `-32601`, the
   * pre-existing behaviour every older suite was written against.
   */
  readonly backgroundTasks?: FakeBackgroundTasksOptions;
  /** ru-code(e2e): step-execution observer for the stdio harness diagnostics. */
  readonly onStepExecuting?: (kind: string) => void;
  /** ru-code(e2e): session id `session/new` answers with (default FAKE_SESSION_ID).
   *  The stdio harness uses a per-process id so parallel threads get separate
   *  transcript files. */
  readonly sessionId?: string;
  /**
   * ru-code: wire-capture hooks (optional). The fake records the session-start
   * `authenticate` methodId and every `session/set_config_option` so tests can
   * assert the exact bytes the adapter sends — the resolved auth method and the
   * `${slug}(${authMethod})` setModel value. Omitted ⇒ no capture (existing tests).
   */
  readonly onAuthenticate?: (methodId: string) => void;
  readonly onSetConfigOption?: (configId: string, value: string | boolean) => void;
  /**
   * ru-code: capture the `RequestPermissionResponse.outcome` the adapter (client)
   * sends back for each `session/request_permission` — the proceed_once /
   * proceed_always / cancelled wire decision the parked callback resolves to.
   * Fires once per request, the instant the client responds. Omitted ⇒ discarded
   * (the historical behaviour).
   */
  readonly onPermissionOutcome?: (outcome: AcpSchema.RequestPermissionResponse["outcome"]) => void;
  /**
   * ru-code: capture the FULL decoded `RequestPermissionResponse` the client sends
   * back — not just `.outcome`. Needed to observe the sibling `answers` field that
   * ask_user_question rides on (qwen reads `output.answers`). onPermissionOutcome
   * discards everything but the outcome, so it cannot see whether `answers`
   * survived the schema encode. Omitted ⇒ discarded.
   */
  readonly onPermissionResponse?: (response: AcpSchema.RequestPermissionResponse) => void;
  /**
   * ru-code: session-setup capture. `onCreateSession` fires when the start
   * handshake takes the fresh `session/new` path; `onLoadSession` fires (with the
   * requested sessionId) when it takes the `session/load` reconnect path. Lets a
   * resume test prove which branch ran (a valid cursor reconnects; an
   * absent/invalid cursor falls back to a fresh start).
   */
  readonly onCreateSession?: () => void;
  /**
   * ru-code: EFFECTFUL session/new observation — runs (awaited) inside the
   * handler BEFORE the response, in the fake agent's fiber. Lets a test
   * observe bind-time state that only exists during the handshake (e.g. the
   * slot overlay file's live bytes) through Effect services it captured in
   * its own context, with no synchronous fs escape hatch. Keep the effect
   * INFALLIBLE (pipe `orDie`): a failing reader derails the fake handshake,
   * which the host typically sees as a start timeout — not as your error.
   */
  readonly onCreateSessionEffect?: () => Effect.Effect<void>;
  readonly onLoadSession?: (sessionId: string) => void;
  /**
   * ru-code: history replay DURING `session/load`. Real qwen re-sends the whole
   * prior conversation as ordinary `session/update` notifications and AWAITS
   * them BEFORE responding to the load (acpAgent.ts createAndStoreSession →
   * HistoryReplayer). The runtime must drop that window (replay suppression)
   * and still stream the NEXT turn normally. Each entry becomes one
   * agent_message_chunk sent before the load response.
   */
  readonly loadReplayChunks?: ReadonlyArray<string>;
  /**
   * ru-code: fires when the agent receives a `session/cancel` (graceful ACP
   * cancel). The Stop button uses end-force SIGKILL (never session/cancel), so a
   * test can assert this was NOT called to prove the force-kill teardown path.
   */
  readonly onCancel?: () => void;
  /**
   * ru-code: how the fake answers the START handshake (`session/new` + `session/load`).
   *   - "ok" (default) → reply with FAKE_SESSION_ID (a real session establishes).
   *   - "hang"         → never respond (simulates a wedged `cli --acp` boot; the
   *                      adapter's start timeout must convert this into an error).
   *   - "error"        → reply with a JSON-RPC error (start fails cleanly).
   *   - "exit"         → the PROCESS DIES (exit 1) instead of responding — real
   *                      qwen 0.13.1 does exactly this on `session/load` of a
   *                      session file with a corrupt non-first line: jsonl.read
   *                      returns [] for the whole file (jsonl-utils.ts:96-109),
   *                      loadSession → undefined, and loadCliConfig calls
   *                      process.exit(1) (config.ts:998-1002) — a process death
   *                      mid-request, NOT a JSON-RPC error.
   */
  readonly startBehavior?: "ok" | "hang" | "error" | "exit";
  /**
   * ru-code: overrides the START behaviour for `session/load` ONLY (`session/new`
   * keeps following `startBehavior`). Lets a resume test express "load fails but
   * a fresh create succeeds" — the fallback path. Omitted ⇒ `session/load`
   * follows `startBehavior`, exactly as before.
   */
  readonly loadBehavior?: "ok" | "error" | "exit";
  /**
   * ru-code: how the fake answers `initialize` — the very first RPC, before any
   * session exists. Real qwen only reaches its ACP loop at the END of main()
   * (gemini.tsx:410); everything before it can kill or wedge the process with
   * the host's initialize left pending:
   *   - "ok" (default) → normal capabilities response.
   *   - "hang"         → never respond (boot stalled — e.g. a network-stalled
   *                      boot auth refresh, initializeApp → refreshAuth, runs
   *                      BEFORE runAcpAgent creates the connection).
   *   - "exit"         → process dies without responding (fatal boot error —
   *                      e.g. malformed settings JSON throws FatalConfigError,
   *                      exit code 52, settings.ts:726-733 + errors.ts:154).
   * Drives the WARMUP failure paths of the warm pool (a prewarmed child that
   * crashes or wedges before it ever answers initialize).
   */
  readonly initializeBehavior?: "ok" | "hang" | "exit";
  /** Exit code for `initializeBehavior: "exit"`. Default 52 (FatalConfigError). */
  readonly initializeExitCode?: number;
  /**
   * ru-code: how the parked prompt settles after a `session/cancel`.
   *   - "cancelled" (default) → resolve with stopReason "cancelled" (qwen's
   *     normal next-checkpoint cancel, Session.ts:293-295).
   *   - "error" → FAIL the pending `session/prompt` with a JSON-RPC error —
   *     real qwen has this race: when the abort fires as an AbortError thrown
   *     by the underlying stream (instead of a yield), the catch at
   *     Session.ts:330-339 rethrows non-429 errors, so the cancelled prompt
   *     resolves as an ERROR response, not a cancelled stopReason. A host that
   *     already settled the turn on Stop must not let this late error corrupt
   *     its state.
   */
  readonly cancelResponse?: "cancelled" | "error";
  /**
   * ru-code: raw bytes the SHELL writes to the child's stdout BEFORE the agent
   * serves its first frame — boot-time stdout pollution. Real qwen redirects
   * console.log/info/debug to stderr only INSIDE runAcpAgent (acpAgent.ts:81-83);
   * anything printed to real stdout before that line (or any direct
   * process.stdout.write — never redirected) lands in front of the host's
   * ndjson parser. Stock 0.13.1 is clean on the traced paths, but fork builds /
   * wrappers can differ — the pool must survive a parser-poisoned child.
   * Consumed by fakeAcpSpawner (transport-level; the agent never sees it).
   */
  readonly preludeStdout?: string;
  /**
   * ru-code: the model advertisement in the START responses. qwen 0.13.1 returns
   * `models: { currentModelId, availableModels[] }` on BOTH `session/new` and
   * `session/load` (acpAgent.ts newSession/loadSession → buildAvailableModels),
   * each entry `{ modelId: "id(authType)", name, description, _meta: { contextLimit } }`.
   * Set this to drive the adapter's channel-A model discovery with the real shape.
   */
  readonly sessionModels?: AcpSchema.SessionModelState;
  /**
   * ru-code: make `session/set_config_option` for `configId:"model"` FAIL with
   * this JSON-RPC error — the qwen-local registry miss surfaces exactly like
   * this (`Model 'X' not found for authType 'Y'` thrown in modelsConfig.ts →
   * SDK internalError -32603 with data.details). Drives channel-B discovery.
   */
  readonly setModelError?: { code: number; message: string; data?: unknown };
  /**
   * ru-code: capture each `session/prompt`'s first text block — the exact text
   * the adapter dispatched (e.g. the hidden "/compress" of compactContext).
   */
  readonly onPromptText?: (text: string) => void;
  /**
   * ru-code: out-of-band agent→client emitter, handed to the test once the
   * fake agent is wired. Real qwen does NOT await its chunk notifications
   * (qwen-code Session.ts:308 calls emitMessage without await inside the
   * stream loop), so a chunk can reach the client AFTER the `session/prompt`
   * response. The step DSL can't express that (steps run before the terminal
   * response); this hook lets a test send a chunk at a point IT controls —
   * e.g. strictly after `sendTurn` returned, when the adapter's turn finalizer
   * has provably run.
   */
  readonly onOutOfBandEmitter?: (emit: {
    readonly agentMessageChunk: (text: string) => Effect.Effect<void>;
    /**
     * ru-code (agentic-flow wave, P2): the pseudo-turn's FIRST frame —
     * `#emitBackgroundNotificationDisplay` (Session.ts:6027-6044). Out-of-band
     * by construction: it fires with NO `session/prompt` of ours enclosing it
     * (research §3.3), which the step DSL cannot express because every step runs
     * inside a prompt.
     */
    readonly backgroundNotificationDisplay: (item: {
      readonly taskId: string;
      readonly description: string;
      readonly subagentType?: string;
      readonly status: QwenAgentTaskLifecycleStatus;
      readonly toolUseId?: string;
      /** Overrides the transcribed `displayLine`; omit to use qwen's own. */
      readonly displayText?: string;
    }) => Effect.Effect<void>;
    /**
     * The MODEL's own words inside the pseudo-turn —
     * `#emitBackgroundNotificationResponse` (Session.ts:6046-6072).
     */
    readonly backgroundNotificationResponse: (
      item: {
        readonly taskId: string;
        readonly status: QwenAgentTaskLifecycleStatus;
        readonly toolUseId?: string;
      },
      text: string,
    ) => Effect.Effect<void>;
    /**
     * `_qwencode/end_turn` — Session.ts:6074-6087. Fires on EVERY exit path of
     * the pseudo-turn, so it is the only reliable "it is over" signal.
     */
    readonly backgroundEndTurn: (
      reason?: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal",
    ) => Effect.Effect<void>;
  }) => void;
}

type FakeStep =
  | { readonly kind: "text"; readonly text: string; readonly subagentMeta?: QwenSubagentMeta }
  | { readonly kind: "thought"; readonly text: string; readonly subagentMeta?: QwenSubagentMeta }
  | { readonly kind: "signalFrame"; readonly signal: QwenSignalFrame }
  | { readonly kind: "textWithUsage"; readonly text: string; readonly inputTokens: number }
  | { readonly kind: "usageChunk"; readonly inputTokens: number }
  | {
      readonly kind: "plan";
      readonly entries: ReadonlyArray<{ content: string; status: string }>;
    }
  | {
      readonly kind: "toolCall";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly title: string;
      readonly status: "pending" | "in_progress" | "completed" | "failed";
      readonly toolKind: AcpSchema.ToolKind;
      readonly rawInput: unknown;
      readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
    }
  | {
      readonly kind: "toolCallUpdate";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "completed" | "failed";
      readonly text?: string;
      readonly rawOutput?: unknown;
      readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
    }
  | {
      readonly kind: "backgroundLaunch";
      readonly toolCallId: string;
      readonly agentId: string;
      readonly subagentName: string;
      readonly taskDescription: string;
      readonly taskPrompt: string;
      readonly preparing: boolean;
    }
  | {
      readonly kind: "backgroundResume";
      readonly toolCallId: string;
      readonly taskId: string;
      readonly resumeKind: "resumed" | "continued" | "revived";
    }
  | { readonly kind: "agentPreparingStart"; readonly toolCallId: string }
  | { readonly kind: "agentPreparationDiscarded"; readonly toolCallId: string }
  | {
      readonly kind: "toolCallError";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly errorMessage: string;
    }
  | { readonly kind: "orphanChunk"; readonly text: string }
  | {
      readonly kind: "subAgentUsageChunk";
      readonly inputTokens: number;
      readonly parentToolCallId: string;
      readonly subagentType: string;
    }
  | { readonly kind: "requestPermission"; readonly payload: AcpSchema.RequestPermissionRequest }
  | { readonly kind: "sleep"; readonly ms: number }
  | { readonly kind: "awaitGate"; readonly gate: Deferred.Deferred<void> }
  | { readonly kind: "extNotification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "drainMidTurn"; readonly callSite: QwenDrainCallSite }
  | {
      readonly kind: "extRequest";
      readonly method: string;
      readonly params: unknown;
      readonly onOutcome: (outcome: FakeExtRequestOutcome) => void;
    }
  | { readonly kind: "ok"; readonly stopReason: StopReason }
  | {
      readonly kind: "error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    }
  | { readonly kind: "raw"; readonly bytes: string }
  | { readonly kind: "close" }
  | { readonly kind: "exit"; readonly code: number };

class PromptStepsRecorder implements PromptSteps {
  readonly steps: FakeStep[] = [];
  emitText(text: string, subagentMeta?: QwenSubagentMeta): PromptSteps {
    this.steps.push({ kind: "text", text, ...(subagentMeta ? { subagentMeta } : {}) });
    return this;
  }
  emitThought(text: string, subagentMeta?: QwenSubagentMeta): PromptSteps {
    this.steps.push({ kind: "thought", text, ...(subagentMeta ? { subagentMeta } : {}) });
    return this;
  }
  emitSignalFrame(signal: QwenSignalFrame): PromptSteps {
    this.steps.push({ kind: "signalFrame", signal });
    return this;
  }
  spawnGatedByPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps {
    // Deliberately the SAME step kind as an ordinary permission request: the
    // wire shape IS an ordinary permission request. The distinct method name is
    // the documentation — what makes it a gated spawn is the ABSENCE of a
    // sibling emitToolCall, which a reader can only notice if the script says so.
    this.steps.push({ kind: "requestPermission", payload });
    return this;
  }
  emitAgentSpawnGated(input: {
    readonly callId: string;
    readonly description: string;
    readonly subagentType: string;
    readonly prompt?: string;
    readonly runInBackground?: boolean;
    readonly preparing?: boolean;
  }): PromptSteps {
    if (input.preparing !== false) {
      this.steps.push({ kind: "agentPreparingStart", toolCallId: input.callId });
    }
    this.steps.push({
      kind: "requestPermission",
      payload: qwenAgentSpawnPermissionRequest({
        sessionId: FAKE_SESSION_ID,
        callId: input.callId,
        args: {
          description: input.description,
          prompt: input.prompt ?? "do the work",
          subagent_type: input.subagentType,
          ...(input.runInBackground !== undefined
            ? { run_in_background: input.runInBackground }
            : {}),
        },
      }),
    });
    return this;
  }
  sleep(ms: number): PromptSteps {
    this.steps.push({ kind: "sleep", ms });
    return this;
  }
  awaitGate(gate: Deferred.Deferred<void>): PromptSteps {
    this.steps.push({ kind: "awaitGate", gate });
    return this;
  }
  emitTextWithUsage(text: string, inputTokens: number): PromptSteps {
    this.steps.push({ kind: "textWithUsage", text, inputTokens });
    return this;
  }
  emitUsageChunk(inputTokens: number): PromptSteps {
    this.steps.push({ kind: "usageChunk", inputTokens });
    return this;
  }
  emitPlan(entries: ReadonlyArray<{ content: string; status: string }>): PromptSteps {
    this.steps.push({ kind: "plan", entries });
    return this;
  }
  emitToolCall(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly title: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
    readonly kind?: AcpSchema.ToolKind;
    readonly rawInput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps {
    this.steps.push({
      kind: "toolCall",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      title: input.title,
      status: input.status ?? "in_progress",
      toolKind: input.kind ?? "other",
      rawInput: input.rawInput ?? {},
      ...(input.subagentMeta ? { subagentMeta: input.subagentMeta } : {}),
    });
    return this;
  }
  emitToolCallUpdate(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "completed" | "failed";
    readonly text?: string;
    readonly rawOutput?: unknown;
    readonly subagentMeta?: { readonly parentToolCallId: string; readonly subagentType: string };
  }): PromptSteps {
    this.steps.push({
      kind: "toolCallUpdate",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.rawOutput !== undefined ? { rawOutput: input.rawOutput } : {}),
      ...(input.subagentMeta ? { subagentMeta: input.subagentMeta } : {}),
    });
    return this;
  }
  emitSubAgentUsageChunk(input: {
    readonly inputTokens: number;
    readonly parentToolCallId: string;
    readonly subagentType: string;
  }): PromptSteps {
    this.steps.push({ kind: "subAgentUsageChunk", ...input });
    return this;
  }
  emitBackgroundLaunch(input: {
    readonly toolCallId: string;
    readonly agentId: string;
    readonly subagentName: string;
    readonly taskDescription: string;
    readonly taskPrompt?: string;
    readonly preparing?: boolean;
  }): PromptSteps {
    this.steps.push({
      kind: "backgroundLaunch",
      toolCallId: input.toolCallId,
      agentId: input.agentId,
      subagentName: input.subagentName,
      taskDescription: input.taskDescription,
      taskPrompt: input.taskPrompt ?? "do the work",
      preparing: input.preparing ?? true,
    });
    return this;
  }
  emitAgentPreparingStart(toolCallId: string): PromptSteps {
    this.steps.push({ kind: "agentPreparingStart", toolCallId });
    return this;
  }
  emitBackgroundResume(input: {
    readonly toolCallId: string;
    readonly taskId: string;
    readonly kind?: "resumed" | "continued" | "revived";
  }): PromptSteps {
    this.steps.push({
      kind: "backgroundResume",
      toolCallId: input.toolCallId,
      taskId: input.taskId,
      resumeKind: input.kind ?? "continued",
    });
    return this;
  }
  emitAgentPreparationDiscarded(toolCallId: string): PromptSteps {
    this.steps.push({ kind: "agentPreparationDiscarded", toolCallId });
    return this;
  }
  emitToolCallError(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly errorMessage: string;
  }): PromptSteps {
    this.steps.push({ kind: "toolCallError", ...input });
    return this;
  }
  emitOrphanChunk(text: string): PromptSteps {
    this.steps.push({ kind: "orphanChunk", text });
    return this;
  }
  requestPermission(payload: AcpSchema.RequestPermissionRequest): PromptSteps {
    this.steps.push({ kind: "requestPermission", payload });
    return this;
  }
  emitExtNotification(method: string, params: unknown): PromptSteps {
    this.steps.push({ kind: "extNotification", method, params });
    return this;
  }
  extRequest(
    method: string,
    params: unknown,
    onOutcome: (outcome: FakeExtRequestOutcome) => void,
  ): PromptSteps {
    this.steps.push({ kind: "extRequest", method, params, onOutcome });
    return this;
  }
  drainMidTurn(callSite: QwenDrainCallSite = "tool-round-boundary"): PromptSteps {
    this.steps.push({ kind: "drainMidTurn", callSite });
    return this;
  }
  respondOk(stopReason: StopReason = "end_turn"): void {
    this.steps.push({ kind: "ok", stopReason });
  }
  respondError(code: number, message: string, data?: unknown): void {
    this.steps.push({ kind: "error", code, message, ...(data !== undefined ? { data } : {}) });
  }
  writeRaw(bytes: string): void {
    this.steps.push({ kind: "raw", bytes });
  }
  closeTransport(): void {
    this.steps.push({ kind: "close" });
  }
  exit(code: number): void {
    this.steps.push({ kind: "exit", code });
  }
}

/**
 * Build the fake agent over `stdio` and register the core method handlers. Returns
 * after registration; the agent's RPC server runs forked in the current scope.
 * `controls` lets the prompt DSL induce transport-level failures.
 */
export const runFakeAcpAgent = (
  stdio: Stdio.Stdio,
  script: FakeAcpScript,
  controls: FakeAcpTransportControls,
): Effect.Effect<void, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    // Per-prompt cancel hook: session/cancel resolves the in-flight prompt with
    // stopReason "cancelled" (matches qwen's wire behaviour). Stop in the adapter
    // currently force-kills, so this is exercised only by a graceful cancel path.
    // ru-code: the error channel carries `cancelResponse: "error"` — the parked
    // prompt then FAILS with a JSON-RPC error instead of resolving cancelled.
    // ru-code (mid-turn wave, phase 2): PER-SESSION drain state, mirroring
    // Session.ts's two instance fields exactly — `midTurnDrainUnavailable`
    // (Session.ts:1267) and `midTurnDrainTimeoutStrikes` (Session.ts:1268).
    // Instance-scoped there, agent-scoped here: same lifetime, since this fake
    // agent IS one session.
    let midTurnDrainUnavailable = false;
    let midTurnDrainTimeoutStrikes = 0;
    // ru-code (phase 4b, SB6): which drain this is, for `forceOutcomes`.
    let drainIndex = 0;

    const activeCancelRef = yield* Ref.make<
      Deferred.Deferred<StopReason, AcpErrors.AcpRequestError> | undefined
    >(undefined);

    // ru-code: process-death arm shared by initialize/new/load — the child dies
    // without ever responding; the host's pending request fails on EOF + exit.
    const dieWithoutResponse = (code: number) =>
      controls.exit(code).pipe(Effect.andThen(Effect.never));

    yield* agent.handleInitialize(() =>
      // ru-code: boot-failure behaviours (see `initializeBehavior` doc).
      script.initializeBehavior === "hang"
        ? Effect.never
        : script.initializeBehavior === "exit"
          ? dieWithoutResponse(script.initializeExitCode ?? 52)
          : Effect.succeed({
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, embeddedContext: true },
              },
            }),
    );
    yield* agent.handleAuthenticate((request) => {
      script.onAuthenticate?.(request.methodId); // ru-code: capture the resolved methodId
      return Effect.succeed({});
    });
    // ru-code: the START handshake honours `script.startBehavior` so tests can drive
    // a wedged ("hang") or failing ("error") `cli --acp` boot, not just the happy path.
    // session/new and session/load carry DIFFERENT response shapes (only session/new
    // returns a sessionId), so the ok arm differs per handler.
    const handshakeFailure = () =>
      new AcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "start handshake failed (fake)",
      });
    yield* agent.handleCreateSession(() => {
      script.onCreateSession?.(); // ru-code: capture the fresh-start path
      return script.startBehavior === "hang"
        ? Effect.never
        : script.startBehavior === "error"
          ? handshakeFailure()
          : script.startBehavior === "exit"
            ? dieWithoutResponse(1)
            : (script.onCreateSessionEffect?.() ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.succeed({
                    sessionId: script.sessionId ?? FAKE_SESSION_ID,
                    // ru-code: real qwen advertises its model catalog here.
                    ...(script.sessionModels ? { models: script.sessionModels } : {}),
                  }),
                ),
              );
    });
    yield* agent.handleLoadSession((request) => {
      script.onLoadSession?.(request.sessionId); // ru-code: capture the reconnect path
      // ru-code: `loadBehavior` (when set) governs this handler alone.
      const loadBehavior = script.loadBehavior ?? script.startBehavior;
      if (loadBehavior === "hang") return Effect.never;
      if (loadBehavior === "error") return handshakeFailure();
      // ru-code: the corrupt-session-file shape — process.exit(1) mid-load
      // (qwen-code config.ts:998-1002; see the `startBehavior` doc).
      if (loadBehavior === "exit") return dieWithoutResponse(1);
      // ru-code: replay history DURING the load, awaited before the response —
      // exactly like real qwen (see the loadReplayChunks doc).
      return Effect.forEach(
        script.loadReplayChunks ?? [],
        (text) =>
          agent.client.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
              // Real replay chunks carry the record timestamp (HistoryReplayer).
              _meta: { timestamp: 1_700_000_000_000 },
            },
          }),
        { discard: true },
      ).pipe(
        // ru-code: session/load re-advertises the catalog too (acpAgent.ts:239-247).
        Effect.as(script.sessionModels ? { models: script.sessionModels } : {}),
        Effect.orDie,
      );
    });
    yield* agent.handleSetSessionConfigOption((request) => {
      // ru-code: capture the setModel wire — configId "model" + the encoded value.
      script.onSetConfigOption?.(request.configId, request.value);
      // ru-code: scripted qwen-local registry miss for channel-B discovery tests.
      if (script.setModelError && request.configId === "model") {
        return new AcpErrors.AcpRequestError({
          code: script.setModelError.code,
          errorMessage: script.setModelError.message,
          ...(script.setModelError.data !== undefined ? { data: script.setModelError.data } : {}),
        });
      }
      return Effect.succeed({ configOptions: [] });
    });
    yield* agent.handleSetSessionModel(() => Effect.succeed({}));
    yield* agent.handleCancel(() =>
      Effect.sync(() => script.onCancel?.()).pipe(
        // ru-code: record the graceful session/cancel so a Stop-button test can
        // assert it was NOT reached (the Stop path is end-force SIGKILL).
        Effect.andThen(
          Ref.get(activeCancelRef).pipe(
            Effect.flatMap((deferred) =>
              deferred
                ? // ru-code: `cancelResponse: "error"` reproduces qwen's abort-vs-
                  // error race — the cancelled prompt FAILS with a JSON-RPC error
                  // instead of the clean cancelled stopReason (see the doc).
                  (script.cancelResponse === "error"
                    ? Deferred.fail(
                        deferred,
                        new AcpErrors.AcpRequestError({
                          code: -32603,
                          errorMessage: "The operation was aborted (fake abort-race error)",
                        }),
                      )
                    : Deferred.succeed(deferred, "cancelled")
                  ).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        ),
      ),
    );

    // ru-code (agentic-flow wave, P2): the background-agent ext surface. Two
    // handlers, registered ONLY when the script opts in — without the knob both
    // methods stay unregistered and the host's own client rejects `-32601`
    // (effect-acp client.ts:390-397), which is the 0.13.1 engine.
    const backgroundTasks = script.backgroundTasks;
    if (backgroundTasks !== undefined) {
      let pollIndex = 0;
      yield* agent.handleExtRequest(QWEN_SESSION_TASKS_METHOD, QwenSessionTasksRequest, (params) =>
        Effect.suspend(() => {
          // acpAgent.ts:7458-7462 — invalid/missing sessionId is invalidParams.
          if (params.sessionId.length === 0) {
            return Effect.fail(
              new AcpErrors.AcpRequestError({
                code: -32602,
                errorMessage: "Invalid or missing sessionId",
              }),
            );
          }
          backgroundTasks.onPollAttempt?.();
          const forced = backgroundTasks.pollFailures?.[pollIndex];
          pollIndex += 1;
          if (forced !== undefined) {
            return Effect.fail(
              new AcpErrors.AcpRequestError({
                code: forced.code,
                errorMessage: forced.message,
              }),
            );
          }
          // background-tasks.ts:1661-1676 — the registry prunes BEFORE anything
          // reads it (pruneTerminalEntries runs from emitStatusChange, :1625),
          // so a poll can never see more than 32 finalized rows.
          const served = qwenPruneTerminalEntries(backgroundTasks.entries);
          backgroundTasks.onPoll?.(served);
          return Effect.succeed(
            qwenBuildSessionTasksStatus(
              params.sessionId,
              served,
              backgroundTasks.now ?? 1_700_000_000_000,
            ),
          );
        }),
      );
      yield* agent.handleExtRequest(
        QWEN_SESSION_TASK_CANCEL_METHOD,
        QwenSessionTaskCancelRequest,
        (params) =>
          Effect.suspend(() => {
            // acpAgent.ts:9375-9397 — all three params validated, taskKind last.
            if (params.sessionId.length === 0 || params.taskId.length === 0) {
              return Effect.fail(
                new AcpErrors.AcpRequestError({
                  code: -32602,
                  errorMessage: "Invalid or missing sessionId",
                }),
              );
            }
            if (!QWEN_TASK_KINDS.has(params.taskKind)) {
              return Effect.fail(
                new AcpErrors.AcpRequestError({
                  code: -32602,
                  errorMessage: 'taskKind must be "agent", "shell", or "monitor"',
                }),
              );
            }
            const index = backgroundTasks.entries.findIndex((entry) => entry.id === params.taskId);
            const entry = index >= 0 ? backgroundTasks.entries[index] : undefined;
            const outcome = qwenSessionTaskCancelResponse(entry);
            // Object-identity semantics (research §14.1): `cancel()` mutates the
            // live entry, so the very next poll already reports 'cancelled'.
            if (outcome.nextStatus !== undefined && entry !== undefined && index >= 0) {
              backgroundTasks.entries[index] = {
                ...entry,
                status: outcome.nextStatus,
                endTime: entry.endTime ?? backgroundTasks.now ?? 1_700_000_000_000,
              };
            }
            backgroundTasks.onCancel?.(
              { taskId: params.taskId, taskKind: params.taskKind },
              outcome.response,
            );
            return Effect.succeed(outcome.response);
          }),
      );
    }

    // ru-code: hand the out-of-band emitter to the test (see the hook doc —
    // reproduces qwen's un-awaited chunk emission trailing the prompt response).
    const outOfBandSessionId = script.sessionId ?? FAKE_SESSION_ID;
    const outOfBandEmitter: Parameters<NonNullable<FakeAcpScript["onOutOfBandEmitter"]>>[0] = {
      agentMessageChunk: (text) =>
        agent.client
          .sessionUpdate({
            sessionId: outOfBandSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          })
          // A transport failure here is the scenario under test elsewhere;
          // for the emitter it just means the update was not deliverable.
          .pipe(Effect.asVoid, Effect.orDie),
      backgroundNotificationDisplay: (item) =>
        agent.client
          .sessionUpdate({
            sessionId: outOfBandSessionId,
            update: qwenEmitBackgroundNotificationDisplay({
              displayText:
                item.displayText ??
                qwenBackgroundDisplayLine({
                  description: item.description,
                  status: item.status,
                  ...(item.subagentType !== undefined ? { subagentType: item.subagentType } : {}),
                }),
              taskId: item.taskId,
              status: item.status,
              ...(item.toolUseId !== undefined ? { toolUseId: item.toolUseId } : {}),
            }),
          })
          .pipe(Effect.asVoid, Effect.orDie),
      backgroundNotificationResponse: (item, text) =>
        agent.client
          .sessionUpdate({
            sessionId: outOfBandSessionId,
            update: qwenEmitBackgroundNotificationResponse(item, text),
          })
          .pipe(Effect.asVoid, Effect.orDie),
      backgroundEndTurn: (reason) =>
        agent.client
          .extNotification(
            QWEN_BACKGROUND_END_TURN_METHOD,
            qwenBackgroundEndTurnParams({
              sessionId: outOfBandSessionId,
              reason: reason ?? "end_turn",
            }),
          )
          .pipe(Effect.asVoid, Effect.orDie),
    };
    script.onOutOfBandEmitter?.(outOfBandEmitter);

    yield* agent.handlePrompt((request) =>
      Effect.gen(function* () {
        // ru-code (agentic-flow wave, P1): RE-publish the emitter for the child
        // that is actually serving prompts. The warm pool spawns spares before
        // and after the bound child, so a test that captured the emitter at
        // spawn time could be holding a spare's — and an out-of-band frame sent
        // there reaches a client nobody drains. `??=`-style captures (the
        // pre-existing idiom) are unaffected: the first publish still wins.
        script.onOutOfBandEmitter?.(outOfBandEmitter);
        // ru-code: capture the prompt's first text block — lets a test assert
        // the exact text the adapter sent (e.g. the hidden "/compress").
        const firstBlock = request.prompt[0];
        script.onPromptText?.(firstBlock && firstBlock.type === "text" ? firstBlock.text : "");
        const recorder = new PromptStepsRecorder();
        script.onPrompt(recorder);
        // ru-code: error channel carries the cancelResponse:"error" abort-race.
        const cancelled = yield* Deferred.make<StopReason, AcpErrors.AcpRequestError>();
        yield* Ref.set(activeCancelRef, cancelled);

        // ru-code (agents wave, phase 2): the dialect gate. v1 keeps every
        // literal below byte-identical; v2 routes the shape-bearing frames
        // through the qwen 0.21.1 emitter transcription instead.
        const useV2 = script.dialect === "v2";
        for (const step of recorder.steps) {
          script.onStepExecuting?.(step.kind);
          switch (step.kind) {
            case "sleep":
              // ru-code(e2e): wall-clock pause (browser-harness realism only).
              yield* Effect.sleep(step.ms);
              break;
            case "awaitGate":
              // ru-code (agentic-flow wave, P1): the deterministic interleave.
              yield* Deferred.await(step.gate);
              break;
            case "text":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitAgentMessage(step.text, undefined, step.subagentMeta)
                  : {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: step.text },
                    },
              });
              break;
            case "signalFrame":
              // ru-code (v2 ONLY): qwen 0.13.1 has no goals/stop-hook machinery
              // at all, so under v1 there is nothing truthful to emit.
              if (!useV2) break;
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update:
                  step.signal.kind === "stopHookLoop"
                    ? qwenEmitStopHookLoop({
                        iterationCount: step.signal.iterationCount,
                        reasons: step.signal.reasons,
                        stopHookCount: step.signal.stopHookCount,
                      })
                    : step.signal.kind === "goalTerminal"
                      ? qwenEmitGoalTerminal(step.signal.terminal)
                      : qwenEmitGoalStatus(step.signal.status),
              });
              break;
            case "thought":
              // ru-code (sub-agents): qwen's thought frame carries NO _meta —
              // neither the parent's nor a child's (SubAgentTracker.ts:275).
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitAgentThought(step.text, undefined, step.subagentMeta)
                  : {
                      sessionUpdate: "agent_thought_chunk",
                      content: { type: "text", text: step.text },
                    },
              });
              break;
            case "textWithUsage":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                  // ru-code: qwen stamps running usage on the chunk's _meta; the
                  // adapter reads update._meta.usage.inputTokens off the raw params.
                  _meta: { usage: { inputTokens: step.inputTokens } },
                },
              });
              break;
            case "usageChunk":
              // ru-code: the REAL qwen usage frame — a dedicated agent_message_chunk
              // with EMPTY text carrying _meta.usage (qwen-code MessageEmitter.ts:77-101,
              // called with text=''). This is the ONLY frame qwen stamps usage on.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitUsageMetadata({
                      promptTokenCount: step.inputTokens,
                      candidatesTokenCount: 0,
                      totalTokenCount: step.inputTokens,
                      durationMs: 0,
                    })
                  : {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "" },
                      _meta: {
                        usage: {
                          inputTokens: step.inputTokens,
                          outputTokens: 0,
                          totalTokens: step.inputTokens,
                        },
                        durationMs: 0,
                      },
                    },
              });
              break;
            case "plan":
              // ru-code: the REAL qwen task-list frame. todo_write →
              // PlanEmitter.emitPlan (qwen-code Session.ts:893-906) sends a single
              // session/update with sessionUpdate:"plan" and
              // entries:[{content, priority:"medium", status}] (PlanEmitter.ts).
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitPlan(step.entries)
                  : {
                      sessionUpdate: "plan",
                      entries: step.entries.map((entry) => ({
                        content: entry.content,
                        priority: "medium" as const,
                        // qwen status ∈ pending|in_progress|completed (types.ts:89-92); the
                        // FakeStep carries it as string, so narrow to the ACP PlanEntry union.
                        status: entry.status as "pending" | "in_progress" | "completed",
                      })),
                    },
              });
              break;
            case "toolCall":
              // ru-code: the REAL qwen tool_call frame — `_meta.toolName` always,
              // plus the sub-agent bundle when the frame belongs to a child.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitToolCallStart({
                      toolName: step.toolName,
                      callId: step.toolCallId,
                      status: step.status,
                      args: step.rawInput as Record<string, unknown>,
                      title: step.title,
                      kind: step.toolKind,
                      ...(step.subagentMeta ? { subagentMeta: step.subagentMeta } : {}),
                    })
                  : {
                      sessionUpdate: "tool_call",
                      toolCallId: step.toolCallId,
                      status: step.status,
                      title: step.title,
                      content: [],
                      locations: [],
                      kind: step.toolKind,
                      rawInput: step.rawInput,
                      _meta: { toolName: step.toolName, ...step.subagentMeta },
                    },
              });
              break;
            case "toolCallUpdate":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitToolCallResult({
                      toolName: step.toolName,
                      callId: step.toolCallId,
                      success: step.status === "completed",
                      ...(step.text === undefined
                        ? {}
                        : {
                            content: [
                              { type: "content", content: { type: "text", text: step.text } },
                            ],
                          }),
                      ...(step.rawOutput !== undefined ? { resultDisplay: step.rawOutput } : {}),
                      ...(step.subagentMeta ? { subagentMeta: step.subagentMeta } : {}),
                    })
                  : {
                      sessionUpdate: "tool_call_update",
                      toolCallId: step.toolCallId,
                      status: step.status,
                      content:
                        step.text === undefined
                          ? []
                          : [{ type: "content", content: { type: "text", text: step.text } }],
                      ...(step.rawOutput !== undefined ? { rawOutput: step.rawOutput } : {}),
                      _meta: { toolName: step.toolName, ...step.subagentMeta },
                    },
              });
              break;
            case "agentPreparingStart":
              // ru-code (agentic-flow wave, FIX ROUND 2): dialect-INDEPENDENT.
              // `ToolCallPreparationTracker` is a 0.21.1 construct
              // (tool-call-preparation-tracker.ts) with no 0.13.1 counterpart,
              // so there is no v1 shape to fall back to.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitAgentPreparingStart(step.toolCallId),
              });
              break;
            case "toolCallError":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitToolCallError(step.toolCallId, step.toolName, step.errorMessage),
              });
              break;
            case "agentPreparationDiscarded":
              // Dialect-INDEPENDENT for the same reason as the preparing frame:
              // the tracker that produces it is a 0.21.1 construct.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitPreparationDiscarded(step.toolCallId, "agent"),
              });
              break;
            case "backgroundLaunch":
              // ru-code (agentic-flow wave, FIX ROUND 2): a real background
              // launch puts TWO frames on the wire, and the wave's fixtures used
              // to send only the second. The first is the PREPARING frame
              // (tool-call-preparation-tracker.ts:29-51) — argless, discardable,
              // and the frame that opened the owner's immortal `call_…` rows. A
              // fixture that skips it cannot fail a host that mishandles it,
              // which is why every single-row spec stayed green while production
              // showed 12 rows for 6 agents.
              if (step.preparing) {
                yield* agent.client.sessionUpdate({
                  sessionId: request.sessionId,
                  update: qwenEmitAgentPreparingStart(step.toolCallId),
                });
              }
              // ru-code (agentic-flow wave, P2): dialect-INDEPENDENT on purpose.
              // The background feature does not exist at 0.13.1 at all
              // (research §5: `background-tasks.ts` is absent at that tag), so
              // there is no v1 shape to fall back to — a script that asks for a
              // background launch is by definition asking for the 0.21.1 wire.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitBackgroundLaunch({
                  callId: step.toolCallId,
                  agentId: step.agentId,
                  subagentName: step.subagentName,
                  taskDescription: step.taskDescription,
                  taskPrompt: step.taskPrompt,
                }),
              });
              break;
            case "backgroundResume":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitSendMessageResume({
                  callId: step.toolCallId,
                  taskId: step.taskId,
                  kind: step.resumeKind,
                }),
              });
              break;
            case "orphanChunk":
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: qwenEmitOrphanParentChunk(step.text),
              });
              break;
            case "subAgentUsageChunk":
              // ru-code: same frame as `usageChunk`, tagged as a child's usage.
              yield* agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: useV2
                  ? qwenEmitUsageMetadata({
                      promptTokenCount: step.inputTokens,
                      candidatesTokenCount: 0,
                      totalTokenCount: step.inputTokens,
                      durationMs: 0,
                      subagentMeta: {
                        parentToolCallId: step.parentToolCallId,
                        subagentType: step.subagentType,
                      },
                    })
                  : {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "" },
                      _meta: {
                        usage: {
                          inputTokens: step.inputTokens,
                          outputTokens: 0,
                          totalTokens: step.inputTokens,
                        },
                        durationMs: 0,
                        parentToolCallId: step.parentToolCallId,
                        subagentType: step.subagentType,
                      },
                    },
              });
              break;
            case "requestPermission": {
              // ru-code: agent→client request; blocks until the adapter (client) responds
              // to the parked request, mirroring qwen's held prompt() during plan approval.
              const response = yield* agent.client.requestPermission(step.payload);
              // ru-code: expose the decision the client resolved to (proceed_once /
              // proceed_always / cancelled) for the M2 wire-contract assertions.
              script.onPermissionOutcome?.(response.outcome);
              // ru-code: expose the FULL response so answer-round-trip tests can see
              // the sibling `answers` field (the outcome-only hook cannot).
              script.onPermissionResponse?.(response);
              break;
            }
            case "extNotification":
              // ru-code: fire-and-forget agent→client extension notification (the
              // slash-command /compress feed the adapter's handleUnknownExtNotification reads).
              yield* agent.client.extNotification(step.method, step.params);
              break;
            case "drainMidTurn": {
              const drain = script.midTurnDrain;
              // ru-code: NO KNOB ⇒ the v0.13.1 engine. The drain does not exist
              // at that tag (QWEN_V1_POLLS_MID_TURN === false), so the step is a
              // no-op and the host is never called. This is what keeps every
              // pre-existing suite byte-identical.
              if (drain === undefined) break;

              // Session.ts:4697 — once latched, the handler is never called
              // again for this session's lifetime.
              if (midTurnDrainUnavailable) {
                drain.onDrain?.({
                  callSite: step.callSite,
                  skipped: true,
                  outcome: undefined,
                  deliveredTexts: [],
                  deliveredContent: [],
                  reliable: false,
                  hasQueuedPrompt: false,
                  timeoutStrikes: midTurnDrainTimeoutStrikes,
                  permanentlyDisabled: true,
                });
                break;
              }

              // ru-code (phase 4b, SB6): an injected outcome for this drain.
              const forced = drain.forceOutcomes?.[drainIndex];
              drainIndex += 1;
              const requireQueuedPromptState =
                step.callSite !== "tool-round-boundary" && step.callSite !== "stopped-tool-run";
              const timeoutMs = drain.timeoutMs ?? QWEN_MID_TURN_DRAIN_TIMEOUT_MS;

              // Session.ts:4713-4722 — `Promise.race([drainPromise, timeoutPromise])`.
              // `Effect.exit` cannot fail, so the timeout is the only other arm.
              const raced =
                forced !== undefined
                  ? forced === "timeout"
                    ? ({ timedOut: true, exit: undefined } as const)
                    : ({
                        timedOut: false,
                        exit: Exit.fail(
                          new AcpErrors.AcpRequestError({
                            code: -32601,
                            errorMessage: `Method not found: ${QWEN_MID_TURN_DRAIN_METHOD}`,
                          }),
                        ),
                      } as const)
                  : yield* Effect.exit(
                      agent.client.extRequest(
                        QWEN_MID_TURN_DRAIN_METHOD,
                        qwenDrainParamsFor(script.sessionId ?? FAKE_SESSION_ID, step.callSite),
                      ),
                    ).pipe(
                      Effect.map((exit) => ({ timedOut: false, exit }) as const),
                      Effect.timeoutOrElse({
                        duration: `${timeoutMs} millis`,
                        orElse: () => Effect.succeed({ timedOut: true, exit: undefined } as const),
                      }),
                    );

              let outcome: FakeExtRequestOutcome | undefined;
              let deliveredTexts: ReadonlyArray<string> = [];
              let deliveredContent: ReadonlyArray<ReadonlyArray<AcpSchema.ContentBlock>> = [];
              let reliable = false;
              let hasQueuedPrompt = false;

              if (raced.timedOut) {
                // Session.ts:4756 — `this.midTurnDrainTimeoutStrikes += 1`.
                midTurnDrainTimeoutStrikes += 1;
              } else if (Exit.isSuccess(raced.exit)) {
                // Session.ts:4726 — any answer at all resets the strike count.
                midTurnDrainTimeoutStrikes = 0;
                const response = raced.exit.value;
                outcome = { kind: "ok", result: response };
                reliable = qwenIsValidDrainResponse(response, requireQueuedPromptState);
                hasQueuedPrompt =
                  response !== null &&
                  typeof response === "object" &&
                  (response as Record<string, unknown>)["hasQueuedPrompt"] === true;
                deliveredTexts = qwenReadDrainedTexts(response);
                deliveredContent = qwenReadDrainedContent(response);
              } else {
                outcome = {
                  kind: "error",
                  code: readExtRequestErrorCode(raced.exit),
                  message: readExtRequestErrorMessage(raced.exit),
                };
              }

              // Session.ts:4774-4783 — the permanent-latch decision.
              if (
                qwenIsPermanentDrainFailure({
                  errorCode: outcome?.kind === "error" ? outcome.code : undefined,
                  errorMessage: outcome?.kind === "error" ? outcome.message : undefined,
                  isTimeout: raced.timedOut,
                  consecutiveTimeoutStrikes: midTurnDrainTimeoutStrikes,
                })
              ) {
                midTurnDrainUnavailable = true;
              }

              drain.onDrain?.({
                callSite: step.callSite,
                skipped: false,
                outcome,
                deliveredTexts,
                deliveredContent,
                reliable,
                hasQueuedPrompt,
                timeoutStrikes: midTurnDrainTimeoutStrikes,
                permanentlyDisabled: midTurnDrainUnavailable,
              });
              break;
            }
            case "extRequest": {
              // ru-code (mid-turn wave): the agent→host ext REQUEST direction.
              // A rejection is a real outcome (a host with no responder answers
              // -32601), so the exit is recorded, never propagated — the prompt
              // continues to its own terminal step either way.
              const outcome = yield* Effect.exit(agent.client.extRequest(step.method, step.params));
              step.onOutcome(
                Exit.isSuccess(outcome)
                  ? { kind: "ok", result: outcome.value }
                  : {
                      kind: "error",
                      code: readExtRequestErrorCode(outcome),
                      message: readExtRequestErrorMessage(outcome),
                    },
              );
              break;
            }
            case "raw":
              yield* controls.writeRaw(step.bytes);
              break;
            case "close":
              yield* controls.closeTransport;
              break;
            case "exit":
              yield* controls.exit(step.code);
              break;
            case "ok":
              return { stopReason: step.stopReason };
            case "error":
              return yield* new AcpErrors.AcpRequestError({
                code: step.code,
                errorMessage: step.message,
                ...(step.data !== undefined ? { data: step.data } : {}),
              });
          }
        }
        // No terminal response in the script: park until session/cancel resolves
        // us cancelled, or until the transport dies (the client fails the prompt
        // and this fiber is interrupted on scope teardown).
        const stopReason = yield* Deferred.await(cancelled);
        return { stopReason };
      }),
    );
  });

export { PromptStepsRecorder };
