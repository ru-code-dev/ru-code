// ru-code: qwen sub-agent attribution. qwen tags every sub-agent ACP frame in
// `update._meta` — `{ toolName, parentToolCallId, subagentType }` on tool calls,
// and `{ usage, durationMs, parentToolCallId, subagentType }` on the dedicated
// empty-text usage chunk (qwen-code ToolCallEmitter.ts:64-80/:135-141,
// MessageEmitter.ts:77-101, SubAgentTracker.ts:70-75). The port's typed
// AcpToolCallState drops `_meta`, but the RAW notification reaches this adapter
// intact (AcpRuntimeModel sets `rawPayload: params` on every parsed event), so
// the whole mapping lives here in the zone and no port file is touched.
//
// It turns those frames into the canonical agent surface:
//   · the `agent` tool call            → task.started / task.completed
//   · every frame with a parentToolCallId → tool.progress heartbeat + agentId
//     stamped on the item event, which re-homes it out of the main timeline
//   · the sub-agent usage chunk        → recognised, so the THREAD context meter
//     never counts a child's prompt tokens
import type { ProviderRuntimeEvent, RuntimeTaskUsage } from "@t3tools/contracts";
import type { AcpPlanUpdate, AcpToolCallState } from "../../../provider/acp/AcpRuntimeModel.ts";

/** qwen's tool name for the sub-agent launcher (`ToolNames.AGENT`). */
export const QWEN_AGENT_TOOL_NAME = "agent";

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

/** The three `_meta` keys qwen stamps on sub-agent-bearing frames. */
export interface QwenFrameMeta {
  readonly toolName?: string;
  readonly parentToolCallId?: string;
  readonly subagentType?: string;
}

/** Reads `rawPayload.update._meta`, guarding every level. Never throws. */
export function readQwenFrameMeta(rawPayload: unknown): QwenFrameMeta {
  const update = asRecord(asRecord(rawPayload)?.["update"]);
  const meta = asRecord(update?.["_meta"]);
  if (meta === null) return {};
  const toolName = asText(meta["toolName"]);
  const parentToolCallId = asText(meta["parentToolCallId"]);
  const subagentType = asText(meta["subagentType"]);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
  };
}

/**
 * True for any frame emitted ON BEHALF OF a sub-agent. The thread-level token
 * feed uses it to skip a child's usage chunk: those prompt tokens are the
 * child's context, not the thread's, and they also drive auto-compaction.
 */
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
  | { readonly _tag: "PlainToolCall" };

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
  if (toolCall.status !== "completed" && toolCall.status !== "failed") {
    // Opening frame: the description and the agent type are the CALL ARGS.
    // The frame's `title` is qwen's "Agent: <description>" display string,
    // which makeToolCallState has already rewritten into a generic summary —
    // rawInput is the unambiguous source.
    const rawInput = asRecord(toolCall.data["rawInput"]);
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
    ...(summary !== undefined ? { summary } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(typedUsage !== undefined ? { typedUsage } : {}),
    // ru-code (sub-agents): only when it says something the summary does not —
    // `result` is absent on an early exit, and then summary IS terminateReason.
    ...(terminateReason !== undefined && terminateReason !== summary ? { terminateReason } : {}),
  };
}

// ─── the ROOT AGENT WINDOW ────────────────────────────────────────────────
//
// qwen strips sub-agent `_meta` off text/thought/plan/permission frames
// (SubAgentTracker.ts:275 forwards no meta where its three siblings :149/:174/
// :258 do), so those frames reach us anonymous. They are still attributable
// with certainty, because qwen is STRICTLY SERIAL at three levels: prompts are
// serialized (Session.ts:166-197 — a new prompt aborts and awaits the previous),
// tool calls are awaited one-by-one in a plain for-loop (Session.ts:353-359, no
// Promise.all and no scheduler on the ACP path), and the parent is blocked
// inside `await invocation.execute()` (Session.ts:881) for the whole child run
// with its own stream already fully drained (Session.ts:288-330 runs BEFORE the
// tool loop at :353). Every notification passes one funnel (Session.sendUpdate
// :370-377).
//
// Therefore, between a ROOT `agent` tool_call and its settling tool_call_update,
// each frame is EITHER already stamped with `parentToolCallId` (inner tools,
// usage ticks) OR unstamped and NECESSARILY the child's. There is no third
// category. We prefer the stamp wherever it exists and use the window ONLY for
// unstamped frames — which also keeps a nested spawn attributed to its true
// parent rather than to whichever window happens to be open.
//
// The window is opened by `AgentRootStarted` and closed by `AgentRootSettled`.
// Both boundary frames always survive the runtime's update filter
// (QwenAcpSessionRuntime.ts:882 terminal, :897 root-open bypass), so a window
// can neither be missed nor left open by a swallowed frame.

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
