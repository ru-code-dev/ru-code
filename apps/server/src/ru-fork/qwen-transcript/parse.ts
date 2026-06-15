// ru-fork: pure parse + normalize of qwen's JSONL transcript records into the
// `TranscriptRecord` wire contract. No I/O, no throws — malformed input is
// skipped/counted so one bad line can never poison the feed. Mirrors qwen
// chatRecordingService.ts (ChatRecord), tools.ts (ToolResultDisplay), and
// geminiChat.ts (Part discrimination).
import type {
  TranscriptPart,
  TranscriptRecord,
  TranscriptToolCall,
  TranscriptToolDisplay,
  TranscriptToolStatus,
  TranscriptUsage,
} from "@t3tools/contracts";

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export interface ParseResult {
  readonly records: TranscriptRecord[];
  readonly errorCount: number;
}

/** Split append-only JSONL → parsed objects. Trailing partial/blank lines and
 *  malformed lines are skipped (the latter counted). */
export const parseTranscriptJsonl = (text: string): { rows: Obj[]; errorCount: number } => {
  const rows: Obj[] = [];
  let errorCount = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isObj(parsed)) rows.push(parsed);
      else errorCount += 1;
    } catch {
      errorCount += 1;
    }
  }
  return { rows, errorCount };
};

const normalizePart = (raw: unknown): TranscriptPart => {
  if (!isObj(raw)) return { kind: "unknown", raw };
  if (raw["thought"] === true) {
    return { kind: "thought", text: asString(raw["text"]) ?? "" };
  }
  if (isObj(raw["functionCall"])) {
    const fc = raw["functionCall"];
    return { kind: "function_call", name: asString(fc["name"]) ?? "", args: fc["args"] };
  }
  if (isObj(raw["functionResponse"])) {
    const fr = raw["functionResponse"];
    return {
      kind: "function_response",
      name: asString(fr["name"]) ?? "",
      response: fr["response"],
    };
  }
  if (typeof raw["text"] === "string") {
    return { kind: "text", text: raw["text"] };
  }
  if (isObj(raw["inlineData"])) {
    return { kind: "inline_data", mimeType: asString(raw["inlineData"]["mimeType"]) ?? "" };
  }
  return { kind: "unknown", raw };
};

const normalizeParts = (message: unknown): TranscriptPart[] => {
  if (!isObj(message)) return [];
  const parts = message["parts"];
  if (!Array.isArray(parts)) return [];
  return parts.map(normalizePart);
};

const normalizeUsage = (raw: unknown): TranscriptUsage | undefined => {
  if (!isObj(raw)) return undefined;
  const prompt = asNumber(raw["promptTokenCount"]);
  const cached = asNumber(raw["cachedInputTokenCount"]);
  const output = asNumber(raw["candidatesTokenCount"]);
  const total = asNumber(raw["totalTokenCount"]);
  const usage: TranscriptUsage = {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
};

const TOOL_STATUSES: ReadonlySet<string> = new Set<TranscriptToolStatus>([
  "validating",
  "scheduled",
  "error",
  "success",
  "executing",
  "cancelled",
  "awaiting_approval",
]);

const normalizeDisplay = (raw: unknown): TranscriptToolDisplay | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return { kind: "text", text: raw };
  if (!isObj(raw)) return { kind: "unknown", raw };

  if (typeof raw["fileDiff"] === "string") {
    return {
      kind: "file_diff",
      fileName: asString(raw["fileName"]) ?? "",
      fileDiff: raw["fileDiff"],
      originalContent: typeof raw["originalContent"] === "string" ? raw["originalContent"] : null,
      newContent: asString(raw["newContent"]) ?? "",
      ...(raw["diffStat"] !== undefined ? { diffStat: raw["diffStat"] } : {}),
    };
  }

  const type = raw["type"];
  if (type === "todo_list" && Array.isArray(raw["todos"])) {
    const todos = raw["todos"]
      .filter(isObj)
      .map((todo) => ({
        id: asString(todo["id"]) ?? "",
        content: asString(todo["content"]) ?? "",
        status: ((): "pending" | "in_progress" | "completed" => {
          const status = todo["status"];
          return status === "in_progress" || status === "completed" ? status : "pending";
        })(),
      }));
    return { kind: "todo_list", todos };
  }
  if (type === "plan_summary") {
    return {
      kind: "plan_summary",
      message: asString(raw["message"]) ?? "",
      plan: asString(raw["plan"]) ?? "",
      ...(typeof raw["rejected"] === "boolean" ? { rejected: raw["rejected"] } : {}),
    };
  }
  if (type === "task_execution") {
    return {
      kind: "task_execution",
      subagentName: asString(raw["subagentName"]) ?? "",
      status: asString(raw["status"]) ?? "",
      taskDescription: asString(raw["taskDescription"]) ?? "",
      ...(asString(raw["result"]) !== undefined ? { result: asString(raw["result"]) } : {}),
      ...(Array.isArray(raw["toolCalls"]) ? { toolCalls: raw["toolCalls"] } : {}),
    };
  }
  if (type === "mcp_tool_progress") {
    return {
      kind: "mcp_progress",
      progress: asNumber(raw["progress"]) ?? 0,
      ...(asNumber(raw["total"]) !== undefined ? { total: asNumber(raw["total"]) } : {}),
      ...(asString(raw["message"]) !== undefined ? { message: asString(raw["message"]) } : {}),
    };
  }
  if (raw["ansiOutput"] !== undefined) {
    return { kind: "ansi", raw: raw["ansiOutput"] };
  }
  return { kind: "unknown", raw };
};

const normalizeToolCall = (raw: unknown): TranscriptToolCall | undefined => {
  if (!isObj(raw)) return undefined;
  const callId = asString(raw["callId"]);
  const statusRaw = raw["status"];
  const status =
    typeof statusRaw === "string" && TOOL_STATUSES.has(statusRaw)
      ? (statusRaw as TranscriptToolStatus)
      : undefined;
  const display = normalizeDisplay(raw["resultDisplay"]);
  return {
    ...(callId !== undefined ? { callId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(display !== undefined ? { display } : {}),
  };
};

const SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "chat_compression",
  "slash_command",
  "ui_telemetry",
  "at_command",
]);

/** qwen ChatRecord → TranscriptRecord. Returns null for an unusable row. */
export const normalizeRecord = (raw: Obj): TranscriptRecord | null => {
  const type = raw["type"];
  const uuid = asString(raw["uuid"]);
  const sessionId = asString(raw["sessionId"]);
  const timestamp = asString(raw["timestamp"]);
  if (uuid === undefined || sessionId === undefined || timestamp === undefined) return null;

  const base = {
    uuid,
    parentUuid: typeof raw["parentUuid"] === "string" ? raw["parentUuid"] : null,
    sessionId,
    timestamp,
    cwd: asString(raw["cwd"]) ?? "",
    ...(asString(raw["gitBranch"]) !== undefined ? { gitBranch: asString(raw["gitBranch"]) } : {}),
  };

  if (type === "user") {
    return { ...base, type: "user", parts: normalizeParts(raw["message"]) };
  }
  if (type === "assistant") {
    const usage = normalizeUsage(raw["usageMetadata"]);
    return {
      ...base,
      type: "assistant",
      parts: normalizeParts(raw["message"]),
      ...(asString(raw["model"]) !== undefined ? { model: asString(raw["model"]) } : {}),
      ...(asNumber(raw["contextWindowSize"]) !== undefined
        ? { contextWindowSize: asNumber(raw["contextWindowSize"]) }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (type === "tool_result") {
    const toolCall = normalizeToolCall(raw["toolCallResult"]);
    return {
      ...base,
      type: "tool_result",
      parts: normalizeParts(raw["message"]),
      ...(toolCall !== undefined ? { toolCall } : {}),
    };
  }
  if (type === "system") {
    const subtype = raw["subtype"];
    return {
      ...base,
      type: "system",
      ...(typeof subtype === "string" && SYSTEM_SUBTYPES.has(subtype)
        ? { subtype: subtype as "chat_compression" | "slash_command" | "ui_telemetry" | "at_command" }
        : {}),
      ...(raw["systemPayload"] !== undefined ? { payload: raw["systemPayload"] as Json } : {}),
    };
  }
  return null;
};

/** Full pipeline: JSONL text → ordered normalized records. */
export const parseAndNormalize = (text: string): TranscriptRecord[] => {
  const { rows } = parseTranscriptJsonl(text);
  const records: TranscriptRecord[] = [];
  for (const row of rows) {
    const normalized = normalizeRecord(row);
    if (normalized !== null) records.push(normalized);
  }
  return records;
};
