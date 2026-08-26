// @effect-diagnostics globalDate:off
// ru-code (agentic-flow wave, P2): a 1:1 TRANSCRIPTION of qwen 0.21.1's
// BACKGROUND-AGENT surface — the launch frame, the poll/cancel ext methods, the
// self-initiated notification pseudo-turn, and the crash-recovery restore.
//
// Same law as its sibling `qwen021Frames.ts`: every builder corresponds to
// exactly ONE qwen site and carries that site's `file:line` at tag v0.21.1
// (commit 41b4ee8373). Nothing here is designed. Where qwen spreads
// conditionally we spread conditionally; where qwen drops a field we drop it. A
// behavioural difference between this file and qwen's own output is a BUG here,
// not a design choice.
//
// The wire-facing constants and decoders live in the PRODUCTION contract module
// (`ru-code/qwen/background/backgroundTaskContract.ts`) and are re-exported at
// the bottom, so the fake and the adapter can never drift on a method name, a
// cap or a status vocabulary — the same discipline `qwen021MidTurnDrain.ts`
// applies to `midTurnDrainContract.ts`.
//
// Companion mapping table (fixture field → builder line → research § → qwen src
// line): WORKFLOW/waves/agentic-flow/mapping-table.md.
//
// qwen source root for every pin below:
//   /mnt/mac/Users/user/WORKSPACE/Projects/experements/qwen-code @ v0.21.1
import type * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

import * as NodeCrypto from "node:crypto";

import {
  QWEN_BACKGROUND_END_TURN_METHOD,
  QWEN_MAX_RETAINED_TERMINAL_AGENTS,
  QWEN_SESSION_TASKS_METHOD,
  QWEN_SESSION_TASK_CANCEL_METHOD,
  QWEN_STATUS_SCHEMA_VERSION,
  type QwenAgentTaskLifecycleStatus,
} from "../../../qwen/background/backgroundTaskContract.ts";
import { qwenEmitAgentMessage, qwenEmitToolCallResult } from "./qwen021Frames.ts";

// ─── 1. THE LAUNCH ────────────────────────────────────────────────────────

/**
 * ru-code (agentic-flow wave, FIX ROUND 1): THE REAL AGENT ID.
 *
 * `agent.ts:2839`: `const agentIdSuffix = this.callId ?? randomUUID().slice(0, 8);`
 * `agent.ts:2842`: `agentId: \`${subagentConfig.name}-${agentIdSuffix}\``.
 *
 * On the ACP path `this.callId` is ALWAYS undefined, so the suffix is ALWAYS a
 * random 8-hex slice — never the wire `toolCallId`. Proof chain at v0.21.1:
 *
 *   · `agent.ts:1302` `private callId?: string;` starts undefined and the
 *     constructor (`:1304-1310`) takes no `callId`; `setCallId` (`:1313-1315`)
 *     is the only writer.
 *   · ACP tool calls execute in `Session.runTool` — `Session.ts:7353` says so in
 *     qwen's own words ("duplicated from coreToolScheduler.ts; ACP routes
 *     through this Session path") — and that function calls `setCallId` at
 *     `Session.ts:7181-7185` under `if (policyToolName === ToolNames.MONITOR)`.
 *     `tool-names.ts:30` `AGENT: 'agent'` vs `:55` `MONITOR: 'monitor'` are
 *     distinct constants, so the Agent tool never enters that branch.
 *     `Session.ts:7149`'s `isAgentTool` is computed for an abort controller
 *     (`:7154-7167`) and never gates `setCallId`.
 *   · `coreToolScheduler.ts:1867-1869` DOES call it unconditionally, but that is
 *     the non-ACP scheduler; `CoreToolScheduler` is never instantiated from
 *     `Session.ts` (only referenced in the comment at `:7121`).
 *
 * Confirmed by owner live smoke against real qwen 0.21.1: bg rows keyed by
 * `${name}-${toolCallId}` never matched a poll row and froze at "Working".
 *
 * The earlier `${subagentName}-${toolCallId}` reconstruction is DISPROVEN and
 * deleted (RULINGS 2026-08-27 F1 = OPTION A).
 */
export const qwenBackgroundAgentId = (subagentName: string, suffix?: string): string =>
  `${subagentName}-${suffix ?? NodeCrypto.randomUUID().slice(0, 8)}`;

/**
 * agent.ts:3676-3682 — the background branch's `llmContent`, verbatim, with
 * `ToolNames.SEND_MESSAGE`/`TASK_STOP`/`READ_FILE`/`SHELL` resolved to the
 * literals qwen interpolates (`send_message`, `task_stop`, `read_file`,
 * `run_shell_command` — packages/core/src/tools/tool-names.ts:53/:46/:23/:27).
 *
 * ru-code (agentic-flow wave, FIX ROUND 1): this prose is the ONLY place the real agent id reaches
 * the wire (`agent.ts:3677` interpolates `hookOpts.agentId`; the launch's
 * `AgentResultDisplay` has no id field at all — tools.ts:630-658). It is
 * therefore no longer "transcribed so a spec can prove we never read it": the
 * ruled OPTION A extractor reads exactly this line, so every byte of it is
 * load-bearing and a drift here MUST turn the extractor spec red.
 */
export const qwenBackgroundLaunchLlmContent = (input: {
  readonly agentId: string;
  readonly jsonlPath: string;
}): string =>
  `Background agent launched successfully.\n` +
  `task_id: ${input.agentId} (internal ID — do not mention to the user. Use send_message to continue this agent, or task_stop to cancel.)\n` +
  `The agent is working in the background. You will be notified automatically when it completes.\n` +
  `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\n` +
  `output_file: ${input.jsonlPath}\n` +
  `If asked, you can check progress before completion by using read_file\n` +
  `  or run_shell_command tail on the output file.`;

/**
 * tools.ts:630-641 — `AgentResultDisplay` as the LAUNCH emits it
 * (`this.currentDisplay` after `updateDisplay({status:'background'})`,
 * agent.ts:3673). NO `taskId`/`agentId` field exists in this struct (research
 * §1.3/§7.3) — `status: 'background'` is the entire structured signal.
 */
export const qwenBackgroundLaunchResultDisplay = (input: {
  readonly subagentName: string;
  readonly taskDescription: string;
  readonly taskPrompt: string;
}): Record<string, unknown> => ({
  type: "task_execution",
  subagentName: input.subagentName,
  taskDescription: input.taskDescription,
  taskPrompt: input.taskPrompt,
  status: "background",
});

/**
 * THE LYING LAUNCH FRAME (research §1.2, the headline defect).
 *
 * The wrapping `agent` tool call's `tool_call_update` is emitted with
 * protocol-level `status: 'completed'` BEFORE the subagent has run a single
 * turn: `Session.ts:8082-8088` computes `succeeded = true` (`const succeeded =
 * status === 'success';` is at `:8088`) because the launch
 * `ToolResult` carries no error, and `transcript-replay.ts:279` writes
 * `status: options.success ? 'completed' : 'failed'`.
 *
 * Built through `qwenEmitToolCallResult`
 * (packages/cli/src/acp-integration/session/emitters/tool-call-emitter.ts:164-205
 * — path corrected, verifier F2) so the
 * `_meta` assembly, the `provenance: 'builtin'` stamp and the content folding
 * are the SAME transcription the foreground path already uses — the only thing
 * that makes this frame a background launch is `rawOutput.status`.
 */
export const qwenEmitBackgroundLaunch = (input: {
  readonly callId: string;
  /**
   * ru-code (agentic-flow wave, FIX ROUND 1): the REAL registry id, supplied by the caller and
   * DELIBERATELY unrelated to `callId` — see `qwenBackgroundAgentId`. Passing it
   * in rather than deriving it is what makes the fixture capable of failing a
   * host that reconstructs the id instead of reading it.
   */
  readonly agentId: string;
  readonly subagentName: string;
  readonly taskDescription: string;
  readonly taskPrompt: string;
  readonly jsonlPath?: string;
}): AcpSchema.SessionUpdate =>
  qwenEmitToolCallResult({
    toolName: "agent",
    callId: input.callId,
    // agent.ts:3674 returns a ToolResult with NO `error`, so Session.ts:8088's
    // `succeeded` is true and the wire status is the terminal 'completed'.
    success: true,
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: qwenBackgroundLaunchLlmContent({
            agentId: input.agentId,
            // agent.ts:3009-3013 → agent-transcript.ts:79-88 — the sidecar path
            // is `agent-${agentId}.jsonl`, keyed by the AGENT id, which is why
            // the fixture derives it from `agentId` and not from `callId`.
            jsonlPath: input.jsonlPath ?? `/tmp/subagents/agent-${input.agentId}.jsonl`,
          }),
        },
      },
    ],
    resultDisplay: qwenBackgroundLaunchResultDisplay({
      subagentName: input.subagentName,
      taskDescription: input.taskDescription,
      taskPrompt: input.taskPrompt,
    }),
  });

/**
 * `send_message`'s three SUCCESS `llmContent` shapes, verbatim
 * (send-message.ts:137-140, :154-157, :175-178 at v0.21.1). Transcribed rather
 * than paraphrased: the host reads the task id out of this exact sentence, so a
 * fixture that reworded it would test a wire qwen never sends.
 */
export const qwenSendMessageResumeLlmContent = (input: {
  readonly taskId: string;
  readonly kind: "resumed" | "continued" | "revived";
}): string => {
  switch (input.kind) {
    case "resumed":
      return `Background task "${input.taskId}" resumed with your message as the first continuation instruction.`;
    case "continued":
      return `Background task "${input.taskId}" continued on its existing runtime with your message as the next instruction.`;
    case "revived":
      return `Background task "${input.taskId}" had completed; revived it with your message as the next instruction.`;
  }
};

/**
 * The `send_message` tool call's TERMINAL frame — an ordinary tool result
 * (research §15.4: "The triggering `send_message` tool call itself IS an
 * ordinary ACP-visible `tool_call`/`tool_call_update` pair"). Built through the
 * same `qwenEmitToolCallResult` transcription every other terminal uses, so the
 * `_meta` assembly and content folding cannot drift from the real wire.
 */
export const qwenEmitSendMessageResume = (input: {
  readonly callId: string;
  readonly taskId: string;
  readonly kind: "resumed" | "continued" | "revived";
}): AcpSchema.SessionUpdate =>
  qwenEmitToolCallResult({
    toolName: "send_message",
    callId: input.callId,
    success: true,
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: qwenSendMessageResumeLlmContent({ taskId: input.taskId, kind: input.kind }),
        },
      },
    ],
  });

// ─── 2. THE POLL SNAPSHOT ─────────────────────────────────────────────────

/** `AgentCompletionStats` — background-tasks.ts:209-214. Exactly four fields. */
export interface QwenAgentTaskStats {
  readonly totalTokens: number;
  readonly outputTokens?: number;
  readonly toolUses: number;
  readonly durationMs: number;
}

/**
 * The registry entry fields `serializeAgentTask` reads (tasksSnapshot.ts:40-76).
 * Optionality mirrors `AgentTask`'s own, so a fixture cannot invent a field the
 * serializer would have dropped.
 */
export interface QwenAgentTaskEntry {
  readonly id: string;
  readonly description: string;
  readonly status: QwenAgentTaskLifecycleStatus;
  readonly startTime: number;
  readonly endTime?: number;
  readonly outputFile?: string;
  readonly subagentType?: string;
  readonly isBackgrounded: boolean;
  readonly parentAgentId?: string | null;
  readonly parentName?: string;
  readonly depth?: number;
  readonly error?: string;
  readonly resumeBlockedReason?: string;
  readonly stats?: QwenAgentTaskStats;
  readonly recentActivities?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly at: number;
  }>;
  readonly prompt?: string;
  readonly toolUseId?: string;
  /** background-tasks.ts:1546 — set before the terminal notification fires. */
  readonly notified?: boolean;
}

/** background-tasks.ts:41. */
const MAX_DESCRIPTION_LENGTH = 40;

/**
 * background-tasks.ts:175-194 (`buildBackgroundEntryLabel`). Strips a
 * `"<subagentType>:"` prefix the description already carries, truncates to 40
 * with an ellipsis, then re-prefixes with the subagent type.
 */
export const qwenBuildBackgroundEntryLabel = (
  entry: { readonly description: string; readonly subagentType?: string },
  options: { readonly includePrefix?: boolean } = {},
): string => {
  const includePrefix = options.includePrefix ?? true;
  let raw = entry.description;
  if (entry.subagentType && raw.toLowerCase().startsWith(entry.subagentType.toLowerCase() + ":")) {
    raw = raw.slice(entry.subagentType.length + 1).trimStart();
  }
  const truncated =
    raw.length > MAX_DESCRIPTION_LENGTH ? raw.slice(0, MAX_DESCRIPTION_LENGTH - 1) + "…" : raw;
  return includePrefix && entry.subagentType ? `${entry.subagentType}: ${truncated}` : truncated;
};

/** tasksSnapshot.ts:23-28 (`runtimeMs`). Clamped at zero, endTime wins. */
const qwenRuntimeMs = (
  entry: { readonly startTime: number; readonly endTime?: number },
  now: number,
): number => Math.max(0, (entry.endTime ?? now) - entry.startTime);

/** tasksSnapshot.ts:31-38 (`optionalField`). */
const optionalField = <K extends string, V>(
  key: K,
  value: V | undefined,
): Record<string, unknown> => (value !== undefined ? { [key]: value } : {});

/**
 * tasksSnapshot.ts:40-76 (`serializeAgentTask`), field for field and in qwen's
 * own key order. Note `parentAgentId`'s `?? undefined` normalisation (:58) — a
 * `null` there serialises as ABSENT, never as `null`.
 */
export const qwenSerializeAgentTask = (
  entry: QwenAgentTaskEntry,
  now: number,
): Record<string, unknown> => ({
  kind: "agent",
  id: entry.id,
  label: qwenBuildBackgroundEntryLabel(entry),
  description: entry.description,
  status: entry.status,
  startTime: entry.startTime,
  runtimeMs: qwenRuntimeMs(entry, now),
  outputFile: entry.outputFile,
  ...optionalField("endTime", entry.endTime),
  ...optionalField("subagentType", entry.subagentType),
  isBackgrounded: entry.isBackgrounded,
  ...optionalField("parentAgentId", entry.parentAgentId ?? undefined),
  ...optionalField("parentName", entry.parentName),
  ...optionalField("depth", entry.depth),
  ...optionalField("error", entry.error),
  ...optionalField("resumeBlockedReason", entry.resumeBlockedReason),
  ...optionalField("stats", entry.stats),
  ...(entry.recentActivities && entry.recentActivities.length > 0
    ? {
        recentActivities: entry.recentActivities.map((activity) => ({
          name: activity.name,
          description: activity.description,
          at: activity.at,
        })),
      }
    : {}),
  ...optionalField("prompt", entry.prompt),
  ...optionalField("toolUseId", entry.toolUseId),
});

/**
 * tasksSnapshot.ts:125-151 (`buildSessionTasksStatus`), agent registry only.
 * Shell/monitor rows are structurally identical in envelope and OUT OF SCOPE for
 * this wave (they merge into the same `tasks` array — tasksSnapshot.ts:130-143 —
 * so a fixture that omits them is a subset, never a wrong shape).
 * The `startTime` sort (:143) is transcribed because it is the only ordering
 * guarantee a polling host gets.
 */
export const qwenBuildSessionTasksStatus = (
  sessionId: string,
  entries: ReadonlyArray<QwenAgentTaskEntry>,
  now: number,
): Record<string, unknown> => ({
  v: QWEN_STATUS_SCHEMA_VERSION,
  sessionId,
  now,
  tasks: entries
    .map((entry) => qwenSerializeAgentTask(entry, now))
    .sort((a, b) => (a["startTime"] as number) - (b["startTime"] as number)),
});

/**
 * background-tasks.ts:1661-1676 (`pruneTerminalEntries`) + :147
 * (`MAX_RETAINED_TERMINAL_AGENTS = 32`).
 *
 * THE RETENTION CAP the wave-plan makes law: only entries that ALREADY emitted
 * their terminal notification (`notified === true`, :1663) are evictable, oldest
 * by `endTime ?? startTime` first (:1664-1668). Running/paused/not-yet-notified
 * entries are NEVER evicted (:142-145). A host that polls a long session sees at
 * most 32 finalized rows, with no signal that older ones were dropped — which is
 * why absence-after-terminal must read as normal, not as a lost task.
 */
export const qwenPruneTerminalEntries = (
  entries: ReadonlyArray<QwenAgentTaskEntry>,
): ReadonlyArray<QwenAgentTaskEntry> => {
  const evictable = entries
    .filter((entry) => entry.notified === true)
    .sort(
      (a, b) =>
        (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) || a.startTime - b.startTime,
    );
  const evicted = new Set<string>();
  while (evictable.length > QWEN_MAX_RETAINED_TERMINAL_AGENTS) {
    const oldest = evictable.shift();
    if (oldest) evicted.add(oldest.id);
  }
  return entries.filter((entry) => !evicted.has(entry.id));
};

// ─── 2b. WHAT THE AGENT ACCEPTS ───────────────────────────────────────────

/**
 * acpAgent.ts:7457-7463 — `sessionTasks` reads exactly one param and throws
 * `RequestError.invalidParams` for a missing/empty/non-string `sessionId`. There
 * are no pagination or filter params (research §10.5).
 */
export const QwenSessionTasksRequest = Schema.Struct({ sessionId: Schema.String });

/**
 * acpAgent.ts:9374-9398 — `sessionTaskCancel` requires all THREE params.
 * `taskKind` has no default; anything outside `agent|shell|monitor` throws
 * `invalidParams` (:9389-9397), which is why our caller must send it explicitly.
 * Typed as a plain string here on purpose: the fake must be able to RECEIVE a
 * wrong value in order to reject it the way qwen does.
 */
export const QwenSessionTaskCancelRequest = Schema.Struct({
  sessionId: Schema.String,
  taskId: Schema.String,
  taskKind: Schema.String,
});

/** acpAgent.ts:9390-9392 — the closed set `taskKind` is validated against. */
export const QWEN_TASK_KINDS: ReadonlySet<string> = new Set(["agent", "shell", "monitor"]);

// ─── 3. CANCEL ────────────────────────────────────────────────────────────

/**
 * acpAgent.ts:9404-9426 — the `taskKind: 'agent'` arm of `sessionTaskCancel`.
 *
 *   · not found / already terminal → `{cancelled:false, reason, status?}` — a
 *     typed NO-OP, never a JSON-RPC error (:9415, research §14.1 idempotency).
 *   · `'paused'` → `abandon()` (:9418); `'running'` → `cancel()` (:9420).
 *   · the reply's `status` is read from the SAME live entry object AFTER the
 *     mutation (:9425), so an acted cancel always answers `'cancelled'`.
 */
export const qwenSessionTaskCancelResponse = (
  entry: QwenAgentTaskEntry | undefined,
): { readonly response: Record<string, unknown>; readonly nextStatus?: "cancelled" } => {
  if (!entry || (entry.status !== "running" && entry.status !== "paused")) {
    return {
      response: {
        cancelled: false,
        reason: entry ? "not_running" : "not_found",
        ...(entry ? { status: entry.status } : {}),
      },
    };
  }
  return { response: { cancelled: true, status: "cancelled" }, nextStatus: "cancelled" };
};

// ─── 4. THE SELF-INITIATED NOTIFICATION PSEUDO-TURN ───────────────────────

/**
 * background-tasks.ts:1556-1564 — the human-facing `displayLine`. `statusText`
 * is qwen's own three-way vocabulary (:1556-1561): a cancel reads
 * "was cancelled", not "cancelled".
 */
export const qwenBackgroundDisplayLine = (entry: {
  readonly description: string;
  readonly subagentType?: string;
  readonly status: QwenAgentTaskLifecycleStatus;
}): string => {
  const statusText =
    entry.status === "completed"
      ? "completed"
      : entry.status === "failed"
        ? "failed"
        : "was cancelled";
  return `Background agent "${qwenBuildBackgroundEntryLabel(entry)}" ${statusText}.`;
};

/**
 * ru-code (agentic-flow wave, FIX ROUND 1, verifier F3): the XML escaper the envelope below uses,
 * REPINNED to its implementation. It is NOT in `background-tasks.ts` at all:
 * that file imports it (`background-tasks.ts:27`,
 * `import { escapeXml } from '../utils/xml.js'`) and the real five-replacement
 * body is `packages/core/src/utils/xml.ts:22-29`. The previously cited
 * `background-tasks.ts:196-206` is a comment plus a `@deprecated` type alias.
 */
const escapeXml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

/**
 * background-tasks.ts:1566-1597 — the `<task-notification>` XML fed to the MODEL
 * (never to the host). Transcribed because the pseudo-turn's model-visible half
 * is what makes the host-visible half legible, and because a spec asserts we
 * never render it.
 */
export const qwenBackgroundTaskNotificationXml = (entry: {
  readonly agentId: string;
  readonly toolUseId?: string;
  readonly description: string;
  readonly status: QwenAgentTaskLifecycleStatus;
  readonly result?: string;
  readonly error?: string;
  readonly outputFile?: string;
  readonly stats?: QwenAgentTaskStats;
}): string => {
  const statusText =
    entry.status === "completed"
      ? "completed"
      : entry.status === "failed"
        ? "failed"
        : "was cancelled";
  const parts: string[] = ["<task-notification>", `<task-id>${escapeXml(entry.agentId)}</task-id>`];
  if (entry.toolUseId) parts.push(`<tool-use-id>${escapeXml(entry.toolUseId)}</tool-use-id>`);
  parts.push(
    `<status>${escapeXml(entry.status)}</status>`,
    `<summary>Agent "${escapeXml(entry.description)}" ${statusText}.</summary>`,
  );
  if (entry.result) parts.push(`<result>${escapeXml(entry.result)}</result>`);
  if (entry.error) parts.push(`<result>Error: ${escapeXml(entry.error)}</result>`);
  if (entry.outputFile) parts.push(`<output-file>${escapeXml(entry.outputFile)}</output-file>`);
  if (entry.stats) {
    parts.push(
      "<usage>",
      `<total_tokens>${entry.stats.totalTokens}</total_tokens>`,
      `<tool_uses>${entry.stats.toolUses}</tool_uses>`,
      `<duration_ms>${entry.stats.durationMs}</duration_ms>`,
      "</usage>",
    );
  }
  parts.push("</task-notification>");
  return parts.join("\n");
};

/**
 * Session.ts:6027-6044 (`#emitBackgroundNotificationDisplay`) — the FIRST frame
 * of the pseudo-turn, sent BEFORE any model call (research §10.2 step 1) and
 * with NO `session/prompt` of ours enclosing it.
 *
 * Hand-built, NOT through `createTranscriptMessageUpdate`: qwen builds this
 * literal object itself and its `_meta` is the four documented keys with no
 * `timestamp`/`qwenTranscript` assembly. `toolUseId` is assigned
 * UNCONDITIONALLY (:6040) — an entry without one yields an own key holding
 * `undefined`, which is exactly what qwen puts on the wire.
 */
export const qwenEmitBackgroundNotificationDisplay = (item: {
  readonly displayText: string;
  readonly taskId: string;
  readonly status: QwenAgentTaskLifecycleStatus;
  readonly kind?: "agent" | "shell" | "monitor";
  readonly toolUseId?: string;
}): AcpSchema.SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: item.displayText },
    _meta: {
      source: "background_notification",
      qwenDiscreteMessage: true,
      backgroundTask: {
        taskId: item.taskId,
        status: item.status,
        kind: item.kind ?? "agent",
        toolUseId: item.toolUseId,
      },
    },
  }) as unknown as AcpSchema.SessionUpdate;

/**
 * Session.ts:6046-6072 (`#emitBackgroundNotificationResponse`) — the MODEL's own
 * words in the pseudo-turn, emitted only when the response stream produced text
 * (research §10.2 step 6). Identical envelope to the display frame except
 * `source`, which is the ONLY thing separating "qwen's canned line" from "the
 * model's narration" on the wire.
 */
export const qwenEmitBackgroundNotificationResponse = (
  item: {
    readonly taskId: string;
    readonly status: QwenAgentTaskLifecycleStatus;
    readonly kind?: "agent" | "shell" | "monitor";
    readonly toolUseId?: string;
  },
  text: string,
): AcpSchema.SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: {
      source: "background_notification_response",
      qwenDiscreteMessage: true,
      backgroundTask: {
        taskId: item.taskId,
        status: item.status,
        kind: item.kind ?? "agent",
        toolUseId: item.toolUseId,
      },
    },
  }) as unknown as AcpSchema.SessionUpdate;

/**
 * Session.ts:6074-6087 (`#emitBackgroundNotificationEndTurn`) — exactly three
 * params, no usage payload. Fired on EVERY exit path of the pseudo-turn
 * (research §10.2), so it is the one reliable "the pseudo-turn is over" signal.
 */
export const qwenBackgroundEndTurnParams = (input: {
  readonly sessionId: string;
  readonly reason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
}): Record<string, unknown> => ({
  sessionId: input.sessionId,
  reason: input.reason,
  source: "background_notification",
});

/**
 * ru-code: the ORPHAN PARENT CHUNK — an ordinary, UNTAGGED `agent_message_chunk`
 * arriving with no `session/prompt` in flight.
 *
 * Not a background frame at all: it is what the pseudo-turn's own tool loop
 * (research §10.2 step 7) and every un-awaited trailing chunk look like. Built
 * through the ordinary transcription so the fake cannot accidentally tag it.
 */
export const qwenEmitOrphanParentChunk = (text: string): AcpSchema.SessionUpdate =>
  qwenEmitAgentMessage(text);

export {
  QWEN_BACKGROUND_END_TURN_METHOD,
  QWEN_MAX_RETAINED_TERMINAL_AGENTS,
  QWEN_SESSION_TASKS_METHOD,
  QWEN_SESSION_TASK_CANCEL_METHOD,
  QWEN_STATUS_SCHEMA_VERSION,
};
export type { QwenAgentTaskLifecycleStatus };
