// ru-fork: pure extractor for qwen's ui_telemetry events from a JSONL transcript.
// No I/O, no throws — malformed lines are skipped (one bad line never poisons a
// file). Reads systemPayload.uiEvent (the api_response / tool_call / api_error
// shapes the dashboard needs) plus the base cwd/gitBranch. Structural reads only,
// the same isObject/asString/asNumber style as qwen-transcript/parse.ts.

type UnknownObject = Record<string, unknown>;

const isObject = (value: unknown): value is UnknownObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export interface ApiResponseEvent {
  readonly kind: "api_response";
  readonly timestamp: string;
  readonly model: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly thinkingTokens: number;
  readonly durationMs: number;
  readonly promptId: string | undefined;
}
export interface ToolCallEvent {
  readonly kind: "tool_call";
  readonly timestamp: string;
  readonly functionName: string;
  readonly success: boolean;
  readonly decision: "auto_accept" | "reject" | undefined;
}
export interface ApiErrorEvent {
  readonly kind: "api_error";
  readonly timestamp: string;
  readonly errorType: string;
}
export type TelemetryEvent = ApiResponseEvent | ToolCallEvent | ApiErrorEvent;

export interface FileTelemetry {
  readonly events: ReadonlyArray<TelemetryEvent>;
  /** First non-empty cwd seen (sessions are single-cwd). */
  readonly cwd: string | undefined;
  /** Last non-empty gitBranch seen (the session's effective branch). */
  readonly branch: string | undefined;
  /** First non-empty sessionId seen. */
  readonly sessionId: string | undefined;
  /** Text of the first `user` record — used to recognize our service prompts. */
  readonly firstUserText: string | undefined;
}

/** Pull the plain text out of a `user` record's `message` (string, or {parts:[{text}]}). */
const userMessageText = (message: unknown): string | undefined => {
  if (typeof message === "string") return message;
  if (!isObject(message)) return undefined;
  const parts = message["parts"];
  if (!Array.isArray(parts)) return asString(message["text"]);
  const texts: string[] = [];
  for (const part of parts) {
    if (isObject(part)) {
      const text = asString(part["text"]);
      if (text !== undefined) texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
};

const decisionOf = (value: unknown): "auto_accept" | "reject" | undefined =>
  value === "auto_accept" || value === "reject" ? value : undefined;

const extractUiEvent = (uiEvent: UnknownObject): TelemetryEvent | null => {
  const name = asString(uiEvent["event.name"]);
  const timestamp = asString(uiEvent["event.timestamp"]);
  if (timestamp === undefined) return null;
  if (name?.endsWith(".api_response")) {
    return {
      kind: "api_response",
      timestamp,
      model: asString(uiEvent["model"]),
      inputTokens: asNumber(uiEvent["input_token_count"]) ?? 0,
      outputTokens: asNumber(uiEvent["output_token_count"]) ?? 0,
      cachedTokens: asNumber(uiEvent["cached_content_token_count"]) ?? 0,
      thinkingTokens: asNumber(uiEvent["thoughts_token_count"]) ?? 0,
      durationMs: asNumber(uiEvent["duration_ms"]) ?? 0,
      promptId: asString(uiEvent["prompt_id"]),
    };
  }
  if (name?.endsWith(".tool_call")) {
    const functionName = asString(uiEvent["function_name"]);
    if (functionName === undefined) return null;
    return {
      kind: "tool_call",
      timestamp,
      functionName,
      success: asBoolean(uiEvent["success"]) ?? true,
      decision: decisionOf(uiEvent["decision"]),
    };
  }
  if (name?.endsWith(".api_error")) {
    return {
      kind: "api_error",
      timestamp,
      errorType: asString(uiEvent["error_type"]) ?? "UnknownError",
    };
  }
  return null;
};

/** JSONL text → telemetry events + the file's dimensions. */
export const extractFileTelemetry = (text: string): FileTelemetry => {
  const events: TelemetryEvent[] = [];
  let cwd: string | undefined;
  let branch: string | undefined;
  let sessionId: string | undefined;
  let firstUserText: string | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;

    if (cwd === undefined) cwd = asString(parsed["cwd"]);
    const branchValue = asString(parsed["gitBranch"]);
    if (branchValue !== undefined) branch = branchValue;
    if (sessionId === undefined) sessionId = asString(parsed["sessionId"]);
    if (firstUserText === undefined && parsed["type"] === "user") {
      firstUserText = userMessageText(parsed["message"]);
    }

    if (parsed["type"] !== "system" || parsed["subtype"] !== "ui_telemetry") continue;
    const payload = parsed["systemPayload"];
    if (!isObject(payload)) continue;
    const uiEvent = payload["uiEvent"];
    if (!isObject(uiEvent)) continue;
    const event = extractUiEvent(uiEvent);
    if (event !== null) events.push(event);
  }

  return { events, cwd, branch, sessionId, firstUserText };
};
