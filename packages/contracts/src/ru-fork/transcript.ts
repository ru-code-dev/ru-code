// ru-fork: contract for "advanced chat mode" — a normalized view of qwen's
// on-disk JSONL conversation transcript (read-only). The server's
// QwenTranscriptService parses qwen `ChatRecord` lines into these shapes and
// streams them; the web client renders them. Kept under ru-fork/ so upstream
// re-syncs never collide. See ru-fork-instrumental/advanced-chat/PLAN.md.
import * as Schema from "effect/Schema";

import { ThreadId } from "../baseSchemas.ts";

/** WS method name. Defined here (not in orchestration.ts) to avoid touching upstream. */
export const TRANSCRIPT_WS_METHOD = "orchestration.subscribeTranscript" as const;

/**
 * One normalized part of a message. Maps from a @google/genai `Part` — we read
 * the raw JSON structurally (qwen geminiChat.ts discriminates the same way).
 */
export const TranscriptPart = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("thought"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("function_call"),
    name: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("function_response"),
    name: Schema.String,
    response: Schema.Unknown,
  }),
  Schema.Struct({ kind: Schema.Literal("inline_data"), mimeType: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unknown"), raw: Schema.Unknown }),
]);
export type TranscriptPart = typeof TranscriptPart.Type;

/** qwen CoreToolScheduler `Status`. */
export const TranscriptToolStatus = Schema.Literals([
  "validating",
  "scheduled",
  "error",
  "success",
  "executing",
  "cancelled",
  "awaiting_approval",
]);
export type TranscriptToolStatus = typeof TranscriptToolStatus.Type;

/** Normalized `ToolResultDisplay` union (qwen tools.ts:532). */
export const TranscriptToolDisplay = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("file_diff"),
    fileName: Schema.String,
    fileDiff: Schema.String,
    originalContent: Schema.NullOr(Schema.String),
    newContent: Schema.String,
    diffStat: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    kind: Schema.Literal("todo_list"),
    todos: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        content: Schema.String,
        status: Schema.Literals(["pending", "in_progress", "completed"]),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("plan_summary"),
    message: Schema.String,
    plan: Schema.String,
    rejected: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("task_execution"),
    subagentName: Schema.String,
    status: Schema.String,
    taskDescription: Schema.String,
    result: Schema.optional(Schema.String),
    toolCalls: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp_progress"),
    progress: Schema.Number,
    total: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("ansi"), raw: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("unknown"), raw: Schema.Unknown }),
]);
export type TranscriptToolDisplay = typeof TranscriptToolDisplay.Type;

export const TranscriptToolCall = Schema.Struct({
  callId: Schema.optional(Schema.String),
  status: Schema.optional(TranscriptToolStatus),
  display: Schema.optional(TranscriptToolDisplay),
});
export type TranscriptToolCall = typeof TranscriptToolCall.Type;

export const TranscriptUsage = Schema.Struct({
  promptTokens: Schema.optional(Schema.Number),
  cachedTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
});
export type TranscriptUsage = typeof TranscriptUsage.Type;

const TranscriptBaseFields = {
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  sessionId: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  gitBranch: Schema.optional(Schema.String),
} as const;

export const TranscriptSystemSubtype = Schema.Literals([
  "chat_compression",
  "slash_command",
  "ui_telemetry",
  "at_command",
]);
export type TranscriptSystemSubtype = typeof TranscriptSystemSubtype.Type;

export const TranscriptRecord = Schema.Union([
  Schema.Struct({
    ...TranscriptBaseFields,
    type: Schema.Literal("user"),
    parts: Schema.Array(TranscriptPart),
  }),
  Schema.Struct({
    ...TranscriptBaseFields,
    type: Schema.Literal("assistant"),
    parts: Schema.Array(TranscriptPart),
    model: Schema.optional(Schema.String),
    contextWindowSize: Schema.optional(Schema.Number),
    usage: Schema.optional(TranscriptUsage),
  }),
  Schema.Struct({
    ...TranscriptBaseFields,
    type: Schema.Literal("tool_result"),
    parts: Schema.Array(TranscriptPart),
    toolCall: Schema.optional(TranscriptToolCall),
  }),
  Schema.Struct({
    ...TranscriptBaseFields,
    type: Schema.Literal("system"),
    subtype: Schema.optional(TranscriptSystemSubtype),
    payload: Schema.optional(Schema.Unknown),
  }),
]);
export type TranscriptRecord = typeof TranscriptRecord.Type;

export const TranscriptStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    records: Schema.Array(TranscriptRecord),
  }),
  Schema.Struct({
    kind: Schema.Literal("append"),
    records: Schema.Array(TranscriptRecord),
  }),
]);
export type TranscriptStreamItem = typeof TranscriptStreamItem.Type;

export class TranscriptSubscribeError extends Schema.TaggedErrorClass<TranscriptSubscribeError>()(
  "TranscriptSubscribeError",
  {
    message: Schema.String,
    threadId: Schema.String,
  },
) {}

export const TranscriptRpcSchemas = {
  subscribeTranscript: {
    input: Schema.Struct({ threadId: ThreadId }),
    output: TranscriptStreamItem,
  },
} as const;
