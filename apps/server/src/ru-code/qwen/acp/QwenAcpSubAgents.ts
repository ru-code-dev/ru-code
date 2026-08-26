// ru-code: qwen sub-agent attribution. qwen tags sub-agent ACP frames in
// `update._meta`. At v0.21.1 (qwen-code tag v0.21.1, commit 41b4ee8373) the tags are:
//   · tool calls  — `{ toolName, provenance, parentToolCallId, subagentType }`
//     (tool-call-emitter.ts:96-119/:183-204 → transcript-replay.ts:248-303)
//   · text AND thought chunks — `{ parentToolCallId, subagentType }`
//     (SubAgentTracker.ts:304-310 → MessageEmitter.ts:115-150)
//   · the dedicated empty-text usage chunk — the same pair plus `usage`/`durationMs`
//     (SubAgentTracker.ts:283-288 → MessageEmitter.ts:170-237)
// The port's typed AcpToolCallState drops `_meta`, but the RAW notification reaches
// this adapter intact (AcpRuntimeModel sets `rawPayload: params` on every parsed
// event), so the whole mapping lives here in the zone and no port file is touched.
//
// It turns those frames into the canonical agent surface:
//   · the `agent` tool call            → task.started / task.completed
//   · every frame with a parentToolCallId → tool.progress heartbeat + agentId
//     stamped on the item event, which re-homes it out of the main timeline
//   · the sub-agent usage chunk        → recognised, so the THREAD context meter
//     never counts a child's prompt tokens
//
// ru-code (agents wave, phase 4 / f-5): this header and the window proof below
// USED to assert the opposite of what this file now implements — that qwen
// strips `_meta` off text/thought frames and that its ACP path is strictly
// serial. Both were true of v0.13.1 and are false at v0.21.1. They survived the
// wave unedited because they predate it (`c2c6378e8`), which made the file's
// printed correctness argument contradict its own code. Rewritten against
// v0.21.1; the three stale qwen pins they carried are corrected above.
import type { ProviderRuntimeEvent, RuntimeTaskUsage } from "@t3tools/contracts";
import type { AcpPlanUpdate, AcpToolCallState } from "../../../provider/acp/AcpRuntimeModel.ts";
// ru-code (agentic-flow wave, FIX ROUND 1): the id EXTRACTOR lives in the shared
// wire contract, because the poller, the cancel caller and the fake all have to
// speak the SAME string this classifier keys the row by. It reads qwen's own
// `task_id: <id> (` launch line — the reconstruction it replaced is disproven
// (RULINGS 2026-08-27 F1 = OPTION A).
import {
  readQwenLaunchTaskId,
  readQwenResumedTaskId,
} from "../background/backgroundTaskContract.ts";

/** qwen's tool name for the sub-agent launcher (`ToolNames.AGENT`). */
export const QWEN_AGENT_TOOL_NAME = "agent";

/** qwen's tool name for the background-task messenger (`tool-names.ts:53`). */
export const QWEN_SEND_MESSAGE_TOOL_NAME = "send_message";

/**
 * `taskType` stamped on the synthesized lifecycle. It is deliberately NOT in
 * MONITOR_TASK_TYPES or INERT_TASK_TYPES, so ingestion's classifyTaskAgentKind
 * stamps `agentKind: "agent"` and the row joins the Agents surface.
 */
export const QWEN_SUBAGENT_TASK_TYPE = "subagent";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asWholeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** The `_meta` keys qwen stamps on sub-agent-bearing frames. */
export interface QwenFrameMeta {
  readonly toolName?: string;
  // ru-code (agentic-flow wave, FIX ROUND 3): `emitPreparationDiscarded`'s own
  // marker (tool-call-emitter.ts:148-154) — the only thing that separates a
  // discarded preparation from a genuinely failed tool call on the wire.
  readonly preparationDiscarded?: boolean;
  readonly parentToolCallId?: string;
  readonly subagentType?: string;
  // ru-code (phase 4, f-1): the provenance classifier. NEW at v0.21.1 — grep for
  // `provenance` in v0.13.1's ToolCallEmitter.ts finds nothing (contract §2.6),
  // and every 0.21.1 tool-call frame carries it, including the agent ROOT's own
  // (`provenance:"builtin"`). That makes it the EARLIEST proof on the wire that
  // we are talking to a tagging engine — it arrives with the spawn frame, before
  // any child has spoken. See `isQwenV2WireFrame`.
  readonly provenance?: string;
}

/** Reads `rawPayload.update._meta`, guarding every level. Never throws. */
export function readQwenFrameMeta(rawPayload: unknown): QwenFrameMeta {
  const update = asRecord(asRecord(rawPayload)?.["update"]);
  const meta = asRecord(update?.["_meta"]);
  if (meta === null) return {};
  const toolName = asText(meta["toolName"]);
  const preparationDiscarded = meta["preparationDiscarded"] === true ? true : undefined;
  const parentToolCallId = asText(meta["parentToolCallId"]);
  const subagentType = asText(meta["subagentType"]);
  const provenance = asText(meta["provenance"]);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(preparationDiscarded !== undefined ? { preparationDiscarded } : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

/**
 * True for any frame emitted ON BEHALF OF a sub-agent. The thread-level token
 * feed uses it to skip a child's usage chunk: those prompt tokens are the
 * child's context, not the thread's, and they also drive auto-compaction.
 */
/**
 * ru-code (phase 4, f-1): does this frame PROVE the engine tags child text?
 *
 * `_meta.provenance` is new at v0.21.1 and stamped on every tool-call frame
 * (qwen tool-call-emitter.ts:96-99/:183-186 → transcript-replay.ts:262-266). A
 * 0.13.1 engine never sends it. It therefore answers, from the very first agent
 * spawn frame, the question the wave previously could only answer after a child
 * had spoken: is an UNTAGGED non-empty text chunk the parent's, or a child's?
 *
 * This matters because six `Session.ts` sites emit untagged non-empty
 * `agent_message_chunk`s directly (mapping table §3a), and at least one —
 * `SE:7893`'s PreToolUse-blocked notice — fires from inside the concurrent agent
 * batch, i.e. WITH a window open. Deciding "child" there put a message about
 * agent B onto agent A's live line.
 */
export function isQwenV2WireFrame(rawPayload: unknown): boolean {
  return readQwenFrameMeta(rawPayload).provenance !== undefined;
}

export function isQwenSubAgentFrame(rawPayload: unknown): boolean {
  return readQwenFrameMeta(rawPayload).parentToolCallId !== undefined;
}

/**
 * qwen's own terminal vocabulary (AgentResultDisplay.status) mapped onto the
 * contract's task.completed statuses. `cancelled` is a STOP, not a failure —
 * the panel renders it as a stopped run rather than a red row.
 */
const TERMINAL_AGENT_STATUS: ReadonlyMap<string, "completed" | "failed" | "stopped"> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "stopped"],
]);

/**
 * Maps qwen's AgentStatsSummary onto the contract's RuntimeTaskUsage. Field
 * names differ on three of them (cachedTokens → cachedInputTokens,
 * thoughtTokens → reasoningOutputTokens, totalToolCalls → toolUses); every
 * value is validated as a non-negative integer because the contract's
 * NonNegativeInt rejects anything else. `totalTokens` is required by the
 * contract, so a summary without it produces no usage at all rather than a
 * half-filled record.
 */
function agentUsageFromRawOutput(rawOutput: unknown): RuntimeTaskUsage | undefined {
  const summary = asRecord(asRecord(rawOutput)?.["executionSummary"]);
  if (summary === null) return undefined;
  const totalTokens = asWholeCount(summary["totalTokens"]);
  if (totalTokens === undefined) return undefined;
  const inputTokens = asWholeCount(summary["inputTokens"]);
  const cachedInputTokens = asWholeCount(summary["cachedTokens"]);
  const outputTokens = asWholeCount(summary["outputTokens"]);
  const reasoningOutputTokens = asWholeCount(summary["thoughtTokens"]);
  const toolUses = asWholeCount(summary["totalToolCalls"]);
  const durationMs = asWholeCount(summary["totalDurationMs"]);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** What one ACP tool-call frame means for the Agents surface. */
export type QwenAgentFrame =
  | {
      readonly _tag: "AgentRootStarted";
      readonly taskId: string;
      readonly toolUseId: string;
      readonly title?: string;
      readonly role?: string;
    }
  | {
      readonly _tag: "AgentRootSettled";
      // ru-code (agentic-flow wave, FIX ROUND 3 ADDENDUM): did qwen send an
      // `AgentResultDisplay` at all (`rawOutput`, tools.ts:630-641)? `emitResult`
      // always does — it is the record of a run that happened. `emitError`
      // (tool-call-emitter.ts:216-240) never does, because it answers a call that
      // was REFUSED or failed before execution (`earlyErrorResponse`,
      // Session.ts:7059). The caller needs the distinction: a terminal with no
      // result display, for a task no row was ever opened for, settles nothing.
      readonly hasResultDisplay: boolean;
      readonly taskId: string;
      readonly toolUseId: string;
      readonly status: "completed" | "failed" | "stopped";
      readonly summary?: string;
      readonly title?: string;
      readonly role?: string;
      readonly typedUsage?: RuntimeTaskUsage;
      // ru-code (sub-agents): qwen's own words for WHY a run ended early
      // (AgentResultDisplay.terminateReason — 'CANCELLED', 'MAX_TURNS', …). It is
      // strictly richer than the mapped status, so it rides the completion's
      // `detail` field (the contract's long-form body) instead of being dropped.
      readonly terminateReason?: string;
    }
  | {
      // ru-code (agentic-flow wave, P3a): a BACKGROUND launch. The wrapping
      // `agent` call's terminal frame is a LIE about the agent, and the truth
      // about the launch: qwen returns from the background branch without
      // awaiting the subagent (agent.ts:3666-3684), so `Session.ts:8082-8088`
      // computes `succeeded = true` (`const succeeded = status === 'success';` is
      // at `:8088`) and the wire carries `status: 'completed'`
      // before the child has run a single turn (research §1.2).
      //
      // It is therefore neither a `Started` nor a `Settled` — it is a third
      // thing: an ANNOUNCEMENT that a detached run exists and can only be
      // observed by polling (research §2.3).
      readonly _tag: "AgentBackgroundLaunched";
      /**
       * ru-code (agentic-flow wave, FIX ROUND 1): the task id qwen's own registry, poll snapshot,
       * notification `_meta` and cancel ext-method are keyed by, EXTRACTED from
       * the launch payload's fixed `task_id: <id> (` line (agent.ts:3677) —
       * RULINGS 2026-08-27 F1 = OPTION A.
       *
       * It cannot be reconstructed: its suffix is `randomUUID().slice(0, 8)` on
       * the ACP path (agent.ts:2839, `this.callId` never set there — the full
       * disproof is on `readQwenLaunchTaskId`), and no structured field on any
       * frame carries it.
       */
      readonly taskId: string;
      readonly toolUseId: string;
      readonly title?: string;
      readonly role?: string;
    }
  | {
      readonly _tag: "AgentInnerTool";
      readonly taskId: string;
      readonly toolUseId: string;
      readonly toolName?: string;
      readonly role?: string;
      // ru-code (sub-agents): true on the inner call's TERMINAL frame. Its
      // `detail` is the tool's own result text — the most informative live line
      // the child produces between narration chunks.
      readonly settled: boolean;
      readonly detail?: string;
    }
  | {
      // ru-code (agentic-flow wave, FIX ROUND 2): the OPENING frame of a spawn
      // that is going to detach. It is NOT a row: the row this launch will get
      // is opened by the launch update below, keyed by qwen's real registry id,
      // and a row opened here could never be addressed by anything that speaks
      // that id — that is the immortal `call_…` card the owner's live test
      // showed twelve of. See `qwenSpawnArgsRunInBackground` for why the args
      // alone decide this.
      readonly _tag: "AgentSpawnPending";
      readonly toolUseId: string;
    }
  | {
      // ru-code (agentic-flow wave, FIX ROUND 3, F-A1): the OTHER fate of a
      // preparing frame — the call was DISCARDED before it ever executed
      // (`emitPreparationDiscarded`, tool-call-emitter.ts:135-156). It is not a
      // failed agent: it is an agent that never happened. See the classifier arm
      // for why no row can exist for it and why it must leave no tombstone.
      readonly _tag: "AgentSpawnDiscarded";
      readonly toolUseId: string;
    }
  | { readonly _tag: "PlainToolCall" };

/**
 * ru-code (agentic-flow wave, FIX ROUND 2): IS THIS SPAWN GOING TO DETACH?
 * Decided from the tool-call ARGS — the only thing an opening frame carries.
 *
 * This is not a heuristic we invented. qwen's own resolution
 * (`agent.ts:2526-2536`) is annotated by qwen as *"the source of truth for the
 * background-classification rule. Two UI classifiers replicate it from tool-call
 * args (they cannot see subagentConfig.background) and must be kept in sync when
 * it changes"* (`agent.ts:2506-2513`), and it names them:
 * `packages/web-shell/client/adapters/toolClassification.ts`
 * (`isBackgroundSubAgentToolCall`) and
 * `packages/desktop/packages/shared/src/agent/tool-matching.ts`. We are a third
 * such host, so this is a transcription of the sanctioned replication, not a
 * guess — `toolClassification.ts:39-51`, field for field:
 *
 *   defaultsToBackground = run_in_background undefined
 *                          && working_dir undefined
 *                          && name undefined
 *                          && subagent_type is not the string "fork"
 *   explicitlyBackground = run_in_background === true
 *
 * The two conditions upstream folds in here are already decided by the caller:
 * `isTopLevelQwenAgent` (`:37-38`) holds because `classifyQwenToolCallFrame`
 * returns `AgentInnerTool` for any frame carrying `parentToolCallId` before this
 * is reached, and the `rawOutput.status === 'background'` arm (`:53`) is the
 * LAUNCH UPDATE, which has its own branch here.
 *
 * The `fork` carve-out is qwen's own comment (`:44-48`): args cannot separate an
 * interactive detached fork from a headless one, so a fork without the explicit
 * flag stays foreground — and `agent.ts:926` confirms the effective rule for an
 * interactive session ("set `run_in_background: true` in interactive sessions
 * when you need that result"), which is the only kind of session ACP has.
 *
 * THE ARGLESS PREPARING FRAME LANDS HERE TOO, and correctly: `rawInput: {}`
 * (tool-call-preparation-tracker.ts:41) satisfies every `undefined` above, so a
 * frame that cannot yet say what it is opens nothing. A foreground agent's own
 * opening frame carries `run_in_background: false` and opens its row exactly as
 * before.
 */
function qwenSpawnArgsRunInBackground(rawInput: Record<string, unknown> | null): boolean {
  const runInBackground = rawInput?.["run_in_background"];
  if (runInBackground === true) return true;
  const subagentType = rawInput?.["subagent_type"];
  return (
    runInBackground === undefined &&
    rawInput?.["working_dir"] === undefined &&
    rawInput?.["name"] === undefined &&
    (typeof subagentType !== "string" || subagentType.toLowerCase() !== "fork")
  );
}

/**
 * ru-code (agentic-flow wave, P3a): the launch frame WITHOUT its prose.
 *
 * The wrapping call's `detail` is qwen's launch `llmContent` verbatim
 * (agent.ts:3675-3682 → transcript-replay.ts's content folding): "task_id: …
 * (internal ID — do not mention to the user. Use send_message to continue this
 * agent, or task_stop to cancel.)". It is written FOR THE MODEL and mirrored
 * onto the wire unchanged (research §7.4), so rendering it puts tool names and
 * an id the user was explicitly not meant to see onto the agent's row —
 * "leaked model-facing text in panel rows is a defect" (RULINGS 2026-08-27).
 *
 * Everything the row actually needs (title, role, id) is read from the
 * STRUCTURED `rawOutput` instead, so dropping the prose costs nothing. `data`
 * is left intact: it is the wire record the diff/raw surfaces replay, not a
 * rendered field.
 */
export function stripQwenLaunchProse(toolCall: AcpToolCallState): AcpToolCallState {
  const { detail: _launchProse, ...withoutProse } = toolCall;
  return withoutProse;
}

/** ru-code (sub-agents): the settled flag plus, only then, the result text. */
function innerToolOutcome(toolCall: AcpToolCallState): {
  readonly settled: boolean;
  readonly detail?: string;
} {
  if (toolCall.status !== "completed" && toolCall.status !== "failed") {
    return { settled: false };
  }
  const detail = asText(toolCall.detail);
  return { settled: true, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * Classifies one parsed tool-call frame. Order matters: a sub-agent's own
 * `agent` call (a nested spawn) carries BOTH `toolName: "agent"` and a
 * `parentToolCallId`, and it must be attributed to its parent — so the
 * parent check comes first.
 *
 * The identity is the tool call id itself: qwen passes the `agent` call's
 * callId as `parentToolCallId` to every child frame, so `taskId` needs no
 * correlation table and survives restarts the same way any tool call id does.
 */
export function classifyQwenToolCallFrame(
  toolCall: AcpToolCallState,
  rawPayload: unknown,
): QwenAgentFrame {
  const meta = readQwenFrameMeta(rawPayload);
  if (meta.parentToolCallId !== undefined) {
    return {
      _tag: "AgentInnerTool",
      taskId: meta.parentToolCallId,
      toolUseId: toolCall.toolCallId,
      ...(meta.toolName !== undefined ? { toolName: meta.toolName } : {}),
      ...(meta.subagentType !== undefined ? { role: meta.subagentType } : {}),
      // ru-code (sub-agents): see the AgentInnerTool doc. `detail` is read ONLY
      // off the terminal frame — on an opening frame the same field holds the
      // call's ARGUMENT (the path being read), which is not a result and must
      // never be presented as one.
      ...innerToolOutcome(toolCall),
    };
  }
  if (meta.toolName !== QWEN_AGENT_TOOL_NAME) {
    return { _tag: "PlainToolCall" };
  }
  // ru-code (agentic-flow wave, FIX ROUND 3, F-A1): THE DISCARD, checked before
  // the terminal mapping below — which would otherwise read this frame as a
  // FAILED AGENT RUN. It carries `status:'failed'` and no `rawOutput`, so every
  // field the terminal arm needs is undefined and `task.completed` goes out
  // titleless: `getOrCreate` (subagentRuntime.ts:651-666) then mints a permanent
  // red card named after the wire call id (`:362`) for an agent that never ran.
  //
  // `discard` only ever fires for calls the tracker still holds — `pending` /
  // `resolved`, i.e. NOT yet handed to tool execution (:18-22) — and
  // `finalizeToolCallPreparations` runs in the model stream's own `finally`
  // (Session.ts:3062-3070), before any tool runs. So a discarded agent call has
  // no row anywhere by construction, and the whole correct response is silence.
  if (meta.preparationDiscarded === true) {
    return { _tag: "AgentSpawnDiscarded", toolUseId: toolCall.toolCallId };
  }
  if (toolCall.status !== "completed" && toolCall.status !== "failed") {
    // Opening frame: the description and the agent type are the CALL ARGS.
    // The frame's `title` is qwen's "Agent: <description>" display string,
    // which makeToolCallState has already rewritten into a generic summary —
    // rawInput is the unambiguous source.
    const rawInput = asRecord(toolCall.data["rawInput"]);
    // ru-code (agentic-flow wave, FIX ROUND 2): a spawn that is going to detach
    // gets NO row here. Its row is opened by the launch update, keyed by qwen's
    // real registry id — a row opened from this frame would be keyed by the wire
    // tool call id, which nothing that speaks that registry id can ever address:
    // not the poll snapshot, not the notification `_meta`, not the cancel
    // method. It could therefore never be settled, cancelled, or even named
    // (the argless preparing frame carries no `description`, so the card falls
    // back to its own id — subagentRuntime.ts:362).
    if (qwenSpawnArgsRunInBackground(rawInput)) {
      return { _tag: "AgentSpawnPending", toolUseId: toolCall.toolCallId };
    }
    const title = asText(rawInput?.["description"]);
    const role = asText(rawInput?.["subagent_type"]);
    return {
      _tag: "AgentRootStarted",
      taskId: toolCall.toolCallId,
      toolUseId: toolCall.toolCallId,
      ...(title !== undefined ? { title } : {}),
      ...(role !== undefined ? { role } : {}),
    };
  }
  // Terminal frame: qwen's AgentResultDisplay rides `rawOutput` and is richer
  // than the ACP status (it distinguishes cancelled from failed and carries the
  // final text plus the execution summary).
  const rawOutput = asRecord(toolCall.data["rawOutput"]);
  const declaredStatus = asText(rawOutput?.["status"]);
  // ru-code (agentic-flow wave, P3a): the background launch, checked BEFORE the
  // terminal mapping below. `'background'` is a real `AgentResultDisplay.status`
  // value (qwen tools.ts:636) that the mapping has no entry for, so it used to
  // fall through to the `completed` default and settle a run that had not even
  // started.
  //
  // ru-code (agentic-flow wave, FIX ROUND 1): the id is READ from `detail` — the wrapping call's
  // content, which is qwen's launch `llmContent` verbatim (agent.ts:3676-3682 →
  // transcript-replay.ts's content folding). This runs BEFORE
  // `stripQwenLaunchProse` drops that text from the row, so the one place the id
  // exists is still in hand.
  //
  // THE GUARD (D-P3a-3, re-aimed at the id per RULINGS 2026-08-27 F1): no
  // extractable id, no background branch. A row keyed by nothing can never be
  // updated by a poll, cancelled or settled, so the frame keeps its old terminal
  // treatment instead — a visible outcome rather than a card stuck at "Working".
  const backgroundSubagentName = asText(rawOutput?.["subagentName"]);
  const backgroundTaskId = readQwenLaunchTaskId(toolCall.detail);
  if (declaredStatus === "background" && backgroundTaskId !== undefined) {
    const backgroundTitle = asText(rawOutput?.["taskDescription"]);
    return {
      _tag: "AgentBackgroundLaunched",
      taskId: backgroundTaskId,
      toolUseId: toolCall.toolCallId,
      ...(backgroundTitle !== undefined ? { title: backgroundTitle } : {}),
      ...(backgroundSubagentName !== undefined ? { role: backgroundSubagentName } : {}),
    };
  }
  const status =
    (declaredStatus !== undefined ? TERMINAL_AGENT_STATUS.get(declaredStatus) : undefined) ??
    (toolCall.status === "failed" ? "failed" : "completed");
  const terminateReason = asText(rawOutput?.["terminateReason"]);
  const summary = asText(rawOutput?.["result"]) ?? terminateReason ?? toolCall.detail;
  const title = asText(rawOutput?.["taskDescription"]);
  const role = asText(rawOutput?.["subagentName"]);
  const typedUsage = agentUsageFromRawOutput(rawOutput);
  return {
    _tag: "AgentRootSettled",
    taskId: toolCall.toolCallId,
    toolUseId: toolCall.toolCallId,
    status,
    hasResultDisplay: rawOutput !== null,
    ...(summary !== undefined ? { summary } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(typedUsage !== undefined ? { typedUsage } : {}),
    // ru-code (sub-agents): only when it says something the summary does not —
    // `result` is absent on an early exit, and then summary IS terminateReason.
    ...(terminateReason !== undefined && terminateReason !== summary ? { terminateReason } : {}),
  };
}

/**
 * ru-code (agentic-flow wave, live-issues T3): THE RESUME, READ OFF ITS RESULT.
 *
 * `send_message` targeting a background task id is the ONLY resume trigger that
 * exists (research §15.2 2e), and it reaches us as an ORDINARY tool call pair
 * (§15.4). We read its TERMINAL frame, never the call, for one reason: the
 * terminal is the only point that is race-free by construction — qwen flips the
 * registry entry back to `running` synchronously inside `execute()`, before the
 * result exists (see `readQwenResumedTaskId` for all three pins). Reading the
 * call instead would arm a poll whose very first tick could still see the old
 * terminal status, conclude `allTerminal`, and stop again before the flip.
 *
 * Deliberately NOT a `QwenAgentFrame` tag: this frame is not an agent frame and
 * must keep taking the classifier's `PlainToolCall` path, so its timeline item
 * is unchanged and no existing frame-shape assertion moves.
 */
export function readQwenResumedBackgroundTaskId(
  toolCall: AcpToolCallState,
  rawPayload: unknown,
): string | undefined {
  if (readQwenFrameMeta(rawPayload).toolName !== QWEN_SEND_MESSAGE_TOOL_NAME) return undefined;
  // Only a COMPLETED send_message resumed anything; a failed one is qwen
  // telling us the task could not be continued.
  //
  // DEFENCE IN DEPTH, measured and stated (the M32 disposition): this line is
  // GREEN under its own mutation, because every FAILURE shape opens `Error: `
  // and carries none of the three success verbs, so the pattern already
  // excludes them. It earns its place by encoding the invariant the whole
  // race-freedom argument rests on — that we read the TERMINAL frame, emitted
  // after qwen's synchronous status flip, and never an earlier one. No wire at
  // v0.21.1 puts that sentence on a non-terminal frame, and we cannot prove
  // none ever will.
  return readQwenResumedTaskId(toolCall.detail);
}

/**
 * ru-code (agentic-flow wave, FIX ROUND 3, F-A3): THE SPAWN FRAME OF THE
 * DEFAULT RUNTIME MODE.
 *
 * `AgentTool.getDefaultPermission()` is `'ask'` (agent.ts:1566-1568) and the
 * tool declares no `getConfirmationDetails` override, so it takes the base
 * class's generic `info` confirmation (tools.ts:126-140); `needsConfirmation` is
 * then true in every non-YOLO mode (permissionFlow.ts:125-144), and
 * `resolveQwenMode` never asks qwen for yolo (QwenAdapter.ts:813-822). So on the
 * mode the product DEFAULTS to, `Session.ts:7651` sets `didRequestPermission`
 * and `Session.ts:7861-7871` SKIPS `emitStart`: the args-bearing `tool_call`
 * frame that `classifyQwenToolCallFrame` reads DOES NOT EXIST, and the spawn's
 * name, type and background flag exist only here, on
 * `session/request_permission` (`Session.ts:7677-7697`).
 *
 * Same frame vocabulary as the tool-call classifier, deliberately: the caller
 * opens the row from an `AgentRootStarted` exactly as it does on the auto-edit
 * wire, and qwen's own args rule decides `AgentSpawnPending` here too — the
 * permission frame carries the FULL args, so a spawn that will detach still gets
 * no row from it (its row belongs to the launch update, under qwen's real
 * registry id).
 *
 * THE TITLE IS THE DISCRIMINATOR, and it is load-bearing. Two producers build an
 * `agent` permission request and NEITHER carries an attribution tag:
 *   · top level — `Session.ts:7683`, `title: invocation.getDescription()`, i.e.
 *     `params.description` VERBATIM (agent.ts:1554-1556);
 *   · nested (a child spawning its own sub-agent — nested sub-agents carry the
 *     AgentTool, agent.ts:2158) — `SubAgentTracker.ts:213`, whose title comes
 *     from `resolveToolMetadata`: `displayName + ': ' + description`
 *     (tool-call-emitter.ts:334/:341) = `Agent: <description>`.
 * A nested spawn's own frames carry `parentToolCallId` and classify
 * `AgentInnerTool`, so a root row opened for one would never be settled by
 * anything — a permanent "Working" card. Requiring the title to EQUAL the
 * description is what keeps this to the top-level producer; a future qwen that
 * changed the top-level title would lose the window (today's behaviour), not
 * gain a phantom row.
 *
 * A MATCH ALSO PROVES A 0.21.1 ENGINE, in the same class as `_meta.provenance`
 * (`isQwenV2WireFrame`) and one frame earlier on this wire: v0.13.1's
 * `Session.ts:782-793` builds this exact struct with NO `_meta` key at all
 * (`git show v0.13.1:packages/cli/src/acp-integration/session/Session.ts`),
 * while 0.21.1 stamps `{ toolName, ...interactionMetaFields(…) }` (`:7692-7695`).
 * The caller relies on that when it latches `sawV2AgentWire` beside the window.
 */
export function classifyQwenAgentSpawnPermission(params: unknown): QwenAgentFrame {
  const toolCall = asRecord(asRecord(params)?.["toolCall"]);
  if (toolCall === null) return { _tag: "PlainToolCall" };
  const meta = asRecord(toolCall["_meta"]);
  if (asText(meta?.["toolName"]) !== QWEN_AGENT_TOOL_NAME) return { _tag: "PlainToolCall" };
  const toolCallId = asText(toolCall["toolCallId"]);
  if (toolCallId === undefined) return { _tag: "PlainToolCall" };
  const rawInput = asRecord(toolCall["rawInput"]);
  const title = asText(rawInput?.["description"]);
  if (title === undefined || asText(toolCall["title"]) !== title) {
    return { _tag: "PlainToolCall" };
  }
  if (qwenSpawnArgsRunInBackground(rawInput)) {
    return { _tag: "AgentSpawnPending", toolUseId: toolCallId };
  }
  const role = asText(rawInput?.["subagent_type"]);
  return {
    _tag: "AgentRootStarted",
    taskId: toolCallId,
    toolUseId: toolCallId,
    title,
    ...(role !== undefined ? { role } : {}),
  };
}

// ─── the ROOT AGENT WINDOW ────────────────────────────────────────────────
//
// ru-code (agents wave, phase 4 / f-5): REWRITTEN. The original argument here
// was that qwen strips sub-agent `_meta` off text/thought/plan/permission frames
// and that its ACP path is strictly serial, so an unstamped frame inside an open
// window is NECESSARILY the child's. Both premises were v0.13.1 facts:
//
//   · TAGS. v0.13.1's SubAgentTracker passed no meta on stream text
//     (`git show v0.13.1:…/SubAgentTracker.ts:267-280` — a three-arg
//     `emitMessage(text,'assistant',thought)`), and v0.13.1's
//     `emitAgentMessage`/`emitAgentThought` declared no `subagentMeta`
//     parameter to pass one to. Only `emitUsageMetadata` did
//     (`git show v0.13.1:…/emitters/MessageEmitter.ts:81`) — which is exactly
//     why the usage chunk was the ONE tagged frame at v0.13.1 (mapping §2 row 4).
//     At v0.21.1 `SAT:304-310` forwards `this.subagentMeta` on both text and
//     thought.
//   · SERIALITY. v0.13.1's Session.ts awaited each tool call in a plain
//     `for…of` (`git show v0.13.1:…/Session.ts:344-354`). At v0.21.1
//     `SE:6621-6627` batches consecutive `agent` calls with `concurrent: true`
//     and `runBounded` (`SE:6742-6796`) starts the next before the previous
//     resolves — several roots are open at once and their frames interleave.
//
// So the window is no longer the primary signal for everything. The rule now:
//
//   1. the frame's own `_meta.parentToolCallId` decides, when present;
//   2. the SERIAL window decides otherwise.
//
// The window is not vestigial — for two frame kinds it is still the ONLY signal,
// because qwen leaves them untagged even at v0.21.1:
//   · a child's PLAN — `PlanEmitter.emitPlan` (PE:27-39) takes no subagentMeta
//     and passes none; a child reaches it through the TodoWrite branch of
//     `ToolCallEmitter.emitResult` (TCE:166-180);
//   · a child's PERMISSION REQUEST — `SAT:223-226` stamps `{toolName}` plus
//     `interactionMetaFields(...)` and nothing else.
// It is additionally the whole attribution mechanism on a v0.13.1 engine.
//
// Both boundary frames always survive the runtime's update filter
// (QwenAcpSessionRuntime.ts's terminal and root-open bypasses), so a window can
// neither be missed nor left open by a swallowed frame.

/** Mirrors client-runtime's SUMMARY_CHAR_LIMIT (subagentRuntime.ts:108). */
export const QWEN_AGENT_LINE_LIMIT = 180;

/**
 * Minimum newly-accumulated characters before the live line is re-emitted.
 * qwen streams the child's answer in token-sized chunks; without a quantum the
 * panel row would cost one runtime event (and one ingestion upsert) per token.
 * 24 chars ≈ 4-6 words — the line still visibly moves, at ~1/10th the traffic.
 * Deterministic by construction: a character count, never a timer, so tests do
 * not race a clock.
 */
export const QWEN_AGENT_LINE_QUANTUM = 24;

/** Live state of the ONE root-agent window that can be open at a time. */
export interface QwenAgentWindow {
  readonly taskId: string;
  /** Required by TaskProgressPayload; the run's description, never empty. */
  readonly description: string;
  readonly role: string | undefined;
  // ru-code (P2 zombie settle): carried so a teardown-time terminal settle
  // (settleOpenSubAgentAsStopped) can stamp the SAME linkage fields the real
  // AgentRootStarted/Settled rows carry, without re-deriving them.
  readonly toolUseId: string;
  readonly title: string | undefined;
  /** Everything the child has narrated in this window. */
  text: string;
  /** The last line handed to `task.progress` — re-emission is suppressed. */
  emitted: string;
  /** Characters appended since the last emit (the quantum's counter). */
  pending: number;
  // ru-code (livejitter): index into `normalize(text)` where the PUBLISHED
  // window currently begins. Stays fixed tick to tick — moving it is exactly
  // the "re-anchor" event — and only ever advances (text only grows).
  anchor: number;
}

/**
 * The row's live line for a ONE-SHOT formatted string (plan progress, an inner
 * tool's result line) — never a streaming continuation, so plain tail-slicing
 * is fine: these are always short and freshly built, not re-emitted tick after
 * tick. Whitespace is collapsed so a chunk boundary inside a newline run
 * cannot render as a blank line.
 */
function qwenAgentLiveLine(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= QWEN_AGENT_LINE_LIMIT
    ? normalized
    : `…${normalized.slice(-(QWEN_AGENT_LINE_LIMIT - 1))}`;
}

// ru-code (livejitter): the next word-start at or after `from` in `text`
// (single-spaced by the caller). `from` itself qualifies if it is already
// preceded by the separating space. Falls back to `from` unchanged when no
// boundary exists ahead (one token spanning the whole bound) — a mid-word cut
// is then unavoidable, exactly as the un-anchored slice used to do.
function snapToWordStart(text: string, from: number): number {
  if (from <= 0) return 0;
  if (text[from - 1] === " ") return from;
  const nextSpace = text.indexOf(" ", from);
  return nextSpace === -1 ? from : nextSpace + 1;
}

/**
 * The streaming tail's ANCHORED live line. The published window's left edge
 * (`window.anchor`, an index into the whitespace-collapsed text) stays FIXED
 * between ticks — it only advances when the window would otherwise exceed the
 * ≤180 bound, and then it lands on a word boundary, never mid-word. This is
 * what stops the "scrolls back and forth" jitter: the same left edge keeps
 * being re-emitted (growing on the right) instead of a new mid-word offset
 * being computed from the raw tail every tick.
 */
function qwenAgentAnchoredLine(window: QwenAgentWindow): string {
  const normalized = window.text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "";
  const anchor = Math.min(window.anchor, normalized.length);
  const budget = anchor === 0 ? QWEN_AGENT_LINE_LIMIT : QWEN_AGENT_LINE_LIMIT - 1;
  if (normalized.length - anchor <= budget) {
    const tail = normalized.slice(anchor);
    return anchor === 0 ? tail : `…${tail}`;
  }
  // Re-anchor: same tail-start the un-anchored slice used to pick (the newest
  // LIMIT-1 chars), then snapped forward to the next clean word boundary.
  const target = Math.max(anchor, normalized.length - (QWEN_AGENT_LINE_LIMIT - 1));
  window.anchor = snapToWordStart(normalized, target);
  return `…${normalized.slice(window.anchor)}`;
}

/**
 * ru-code (agents wave): how many root-agent windows may be open at once.
 * Mirrors qwen's own default tool-concurrency cap (`QWEN_CODE_MAX_TOOL_CONCURRENCY`,
 * default 10 — qwen coreToolScheduler.ts:3703-3723 and the ACP mirror at
 * Session.ts:6742-6796), so a well-behaved engine never trips it. Present as a
 * memory bound, not a policy: a runaway/hostile stream must not let one thread
 * accumulate windows forever.
 */
export const QWEN_MAX_OPEN_AGENT_WINDOWS = 10;

/**
 * ru-code (phase 4b, R-6): how many SETTLED agent ids stay remembered, so a
 * straggler for a finished run is recognised instead of re-opening it.
 *
 * Ten generations of the concurrency cap. A straggler is a frame that was
 * already in flight when its agent settled (qwen fires the child's emitters
 * unawaited, SAT:143/:304, while the parent's terminal is awaited elsewhere,
 * SE:8216), so it lands within a few frames of the terminal — it cannot outlive
 * ten full generations of concurrent agents. Bounded because the eviction path
 * writes here too: without a cap, the window cap — whose stated purpose is that
 * a runaway stream cannot make one thread accumulate forever — would just be
 * converting one unbounded structure into another.
 */
export const QWEN_MAX_SETTLED_AGENT_IDS = QWEN_MAX_OPEN_AGENT_WINDOWS * 10;

/**
 * Resolves which agent a frame belongs to. THE precedence rule of the wave:
 *
 *   1. the frame's own `_meta.parentToolCallId` — an explicit fact from qwen;
 *   2. otherwise the SERIAL window (the most recently opened one still open).
 *
 * There is deliberately NO dialect switch in front of this. The rule is correct
 * against BOTH engine generations by construction: a 0.13.1 engine never sends
 * `_meta.parentToolCallId` on a message chunk, so step 1 cannot fire and every
 * frame takes step 2 — precisely the legacy behaviour — while a 0.21.1 engine
 * tags what it can and step 1 does the demultiplexing. Reading a tag that is not
 * there costs one property lookup and cannot be wrong. Anything that decided
 * this from configuration instead would have to be RIGHT about the engine, and
 * the fact available to decide it (the preflight's shipped-node marker) is a
 * proxy for the install layout, not for the wire.
 *
 * Tag first is what makes concurrent agents demultiplexable. The serial fallback
 * is not vestigial: a child's plan and a child's permission request carry no tag
 * even at 0.21.1 (qwen PlanEmitter.ts:27-39, SubAgentTracker.ts:223-226), and a
 * 0.13.1 engine tags no message chunk at all — for those the serial window is the
 * only signal there is.
 *
 * Returns undefined when the tag names an agent we have no open window for: that
 * is a real case (a settled agent's late frame) and it must NOT fall back to the
 * serial window, or a straggler would be misattributed to a live sibling.
 *
 * ru-code (phase 4, f-10): that no-fallback is DEFENSIVE DEPTH, not the guard
 * that carries the case. Measured — making it fall back leaves the suite green,
 * because two other mechanisms reach a straggler first: the caller passes
 * `serialTaskId: undefined` for TEXT once the engine is known to tag
 * (QwenAdapter.ts's v2 latch), and `isQwenSettledAgentFrame` drops the frame
 * outright. The load-bearing guard is the settled-id set; this line is what
 * keeps the function correct in isolation.
 */
export function resolveQwenAgentWindow(
  windows: ReadonlyMap<string, QwenAgentWindow>,
  serialTaskId: string | undefined,
  rawPayload: unknown,
): QwenAgentWindow | undefined {
  const taggedTaskId = readQwenFrameMeta(rawPayload).parentToolCallId;
  if (taggedTaskId !== undefined) return windows.get(taggedTaskId);
  return serialTaskId === undefined ? undefined : windows.get(serialTaskId);
}

/**
 * ru-code (agents wave): a TAGGED frame naming an agent we have no window for.
 *
 * The window mechanism has one structural failure: if the root `agent` frame is
 * missed or dropped, nothing is open, and an untagged child chunk is then
 * indistinguishable from the parent's own words — it leaks into the chat
 * (flow doc §9.2 confirms this is today's behaviour, with no branch anywhere
 * using the tag as a backstop). At 0.21.1 the chunk carries the agent's identity,
 * so the run is recoverable: adopt it, open a window from the tag alone, and let
 * the row exist from its first word.
 *
 * Returns the identity to adopt, or undefined when the frame is untagged (the
 * legacy case, where nothing can be recovered) or already has a window.
 */
/**
 * ru-code (phase 4, B-1): is this frame a straggler from an agent that already
 * finished? Such a chunk is the CHILD's — it must not re-open the run (that was
 * the blocker), must not land on a live sibling (the invariant at
 * `resolveQwenAgentWindow`), and must not fall through to the parent's chat
 * either, which is where "not adopted" alone would leave it. There is no row
 * left to show it on, so the only correct destination is nowhere.
 */
export function isQwenSettledAgentFrame(
  settledTaskIds: ReadonlySet<string>,
  rawPayload: unknown,
): boolean {
  const taskId = readQwenFrameMeta(rawPayload).parentToolCallId;
  return taskId !== undefined && settledTaskIds.has(taskId);
}

export function readQwenOrphanAgent(
  windows: ReadonlyMap<string, QwenAgentWindow>,
  settledTaskIds: ReadonlySet<string>,
  rawPayload: unknown,
): { readonly taskId: string; readonly role?: string } | undefined {
  const meta = readQwenFrameMeta(rawPayload);
  if (meta.parentToolCallId === undefined || windows.has(meta.parentToolCallId)) return undefined;
  // ru-code (phase 4, B-1): "no window for this tag" is ALSO the state a settle
  // leaves behind, so without this the two are indistinguishable and a late
  // straggler re-opens a run that already completed — a green row flipping back
  // to Working and ending the session displayed as Stopped. qwen fires the
  // child's emitters unawaited (SAT:143, SAT:304) while the parent's terminal
  // frame is awaited on another stack (SE:8216), so nothing upstream orders the
  // child's last chunk before the settle: the straggler is reachable, not
  // theoretical. A settled agent's late frame is DROPPED, never adopted.
  if (settledTaskIds.has(meta.parentToolCallId)) return undefined;
  return {
    taskId: meta.parentToolCallId,
    ...(meta.subagentType !== undefined ? { role: meta.subagentType } : {}),
  };
}

/** One entry of qwen's `AgentResultDisplay.toolCalls` rollup, as we consume it. */
export interface QwenReconciledToolCall {
  readonly toolUseId: string;
  readonly toolName?: string;
}

/**
 * ru-code (agents wave): the batched tool calls a settle must replay.
 *
 * qwen puts a child's tool history on the wire TWICE — live, per call, and again
 * as `rawOutput.toolCalls` on the wrapping agent call's terminal frame (contract
 * §2.5). Reading only `executionSummary.totalToolCalls`, as we did, meant a run
 * whose live frames were missed settled claiming a tool count with no tools
 * behind it. Host obligation §7.4 names this rollup as the reconciliation source.
 *
 * Returns ONLY the calls the window has not already published, so the common
 * (nothing-missed) case yields an empty array and the feed is unchanged.
 */
export function reconcileQwenAgentToolCalls(
  rawOutput: unknown,
  seenToolUseIds: Set<string>,
): ReadonlyArray<QwenReconciledToolCall> {
  const calls = asRecord(rawOutput)?.["toolCalls"];
  if (!Array.isArray(calls)) return [];
  const missing: QwenReconciledToolCall[] = [];
  for (const entry of calls) {
    const record = asRecord(entry);
    if (record === null) continue;
    const toolUseId = asText(record["callId"]) ?? asText(record["id"]);
    if (toolUseId === undefined || seenToolUseIds.has(toolUseId)) continue;
    // ru-code (phase 4, f-14): skip entries the rollup shows as still IN FLIGHT.
    // qwen seeds every entry `status:'executing'` the moment the call starts
    // (qwen agent.ts:1372-1376) and moves it to a terminal value on result, so a
    // CANCELLED child's rollup still carries `executing`/`awaiting_approval`
    // (agent.ts:1481-1487) for work that never finished. Replaying those would
    // put activity on the row for tool calls that never ran to completion.
    const rollupStatus = asText(record["status"]);
    if (rollupStatus === "executing" || rollupStatus === "awaiting_approval") continue;
    seenToolUseIds.add(toolUseId);
    const toolName = asText(record["name"]);
    missing.push({ toolUseId, ...(toolName !== undefined ? { toolName } : {}) });
  }
  return missing;
}

export function openQwenAgentWindow(
  frame: Extract<QwenAgentFrame, { readonly _tag: "AgentRootStarted" }>,
): QwenAgentWindow {
  return {
    taskId: frame.taskId,
    // `description` is a required non-empty contract field; the start frame's
    // rawInput.description is the normal source, the agent type and finally the
    // tool name are the fallbacks that keep the feed legal when it is absent.
    description: frame.title ?? frame.role ?? QWEN_AGENT_TOOL_NAME,
    role: frame.role,
    toolUseId: frame.toolUseId,
    title: frame.title,
    text: "",
    emitted: "",
    pending: 0,
    anchor: 0,
  };
}

/**
 * Accumulates one child chunk. Returns the line to publish, or undefined when
 * the quantum has not been reached (or the line would repeat / be empty).
 */
export function appendQwenAgentText(window: QwenAgentWindow, chunk: string): string | undefined {
  window.text += chunk;
  window.pending += chunk.length;
  if (window.pending < QWEN_AGENT_LINE_QUANTUM) return undefined;
  return takeQwenAgentLine(window);
}

/**
 * Publishes whatever is buffered regardless of the quantum. Called when the
 * window closes so an interrupted run keeps the child's last words instead of
 * losing up to a quantum of narration.
 */
export function takeQwenAgentLine(window: QwenAgentWindow): string | undefined {
  window.pending = 0;
  const line = qwenAgentAnchoredLine(window);
  if (line.length === 0 || line === window.emitted) return undefined;
  window.emitted = line;
  return line;
}

/**
 * An in-window `plan` frame is the CHILD's todo list. Forwarding it as
 * `turn.plan.updated` would replace the user's own visible task list with the
 * child's — so it is parked on the agent row as one line instead: progress
 * count plus the step actually in flight. Nothing the user needs is lost and
 * the parent's plan surface stays the parent's.
 */
export function formatQwenAgentPlanLine(payload: AcpPlanUpdate): string | undefined {
  const steps = payload.plan;
  if (steps.length === 0) return undefined;
  const done = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending") ??
    steps[steps.length - 1]!;
  return qwenAgentLiveLine(`▤ ${done}/${steps.length} · ${current.step}`);
}

/**
 * An inner tool's TERMINAL frame line: the tool plus its own result text. The
 * `tool.progress` heartbeat can only carry a tool NAME (the fold reads nothing
 * else from it, subagentRuntime.ts:610-623), so the result would otherwise be
 * dropped — this routes it through the one channel the row actually renders.
 */
export function formatQwenAgentToolLine(
  toolName: string | undefined,
  detail: string | undefined,
): string | undefined {
  const name = asText(toolName);
  const text = asText(detail);
  if (name === undefined && text === undefined) return undefined;
  if (text === undefined) return qwenAgentLiveLine(`▸ ${name!}`);
  return qwenAgentLiveLine(name === undefined ? `▸ ${text}` : `▸ ${name} · ${text}`);
}

/**
 * The line for a child blocked on a permission prompt. Deliberately WORDLESS —
 * a pause glyph plus the tool name — so the server emits no English literal
 * that would owe a dictionary pair, and the row reads the same in both locales.
 */
export function formatQwenAgentWaitingLine(toolName: string | undefined): string {
  const name = asText(toolName);
  return name === undefined ? "⏸" : `⏸ ${name}`;
}

/** The goal's own condition text, when qwen supplied one. */
export function readQwenGoalCondition(payload: Record<string, unknown>): string | undefined {
  return asText(payload["condition"]);
}

/**
 * ru-code (agents wave): the one-line notice for a goal signal.
 *
 * Deliberately built from qwen's OWN words (`kind` and `condition`) plus a single
 * glyph, with no English sentence around them — the server owes no dictionary
 * pair for it and it reads the same in both locales, exactly like the wordless
 * waiting line above. `kind` is qwen's vocabulary
 * (set|checking|achieved|cleared|failed|aborted — qwen ui/types.ts:620-629), so a
 * new one it invents passes through instead of being mapped to a wrong word.
 */
export function formatQwenGoalLine(
  signal: "goalTerminal" | "goalStatus",
  payload: Record<string, unknown>,
): string {
  const kind = asText(payload["kind"]) ?? signal;
  const condition = readQwenGoalCondition(payload);
  return qwenAgentLiveLine(condition === undefined ? `◎ ${kind}` : `◎ ${kind} · ${condition}`);
}

/**
 * Stamps agent ownership on an item lifecycle event built by the port's
 * `makeAcpToolCallEvent`. `agentId` re-homes the row out of the parent chat
 * (session-logic's isAgentInternalActivity hides non-task rows that carry one)
 * and into the owning agent; `parentToolUseId` is the same id because the
 * owning agent IS that tool call. Non-item events pass through untouched.
 */
export function withQwenAgentAttribution(
  event: ProviderRuntimeEvent,
  agentId: string,
): ProviderRuntimeEvent {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      return {
        ...event,
        payload: { ...event.payload, agentId, parentToolUseId: agentId },
      };
    default:
      return event;
  }
}
