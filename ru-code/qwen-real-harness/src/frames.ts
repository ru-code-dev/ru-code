// ru-code (qwen-compression wave): reading a captured `session/update` params
// object — the shape questions the frame diff asks, and nothing else.
//
// Kept separate from the fake's builders on purpose: the builders SAY what the
// wire looks like, these readers ASK. If a reader had to agree with a builder to
// work, the diff between them would prove nothing.

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export interface CapturedFrame {
  readonly sessionId: string | undefined;
  readonly sessionUpdate: string | undefined;
  readonly text: string | undefined;
  readonly meta: Record<string, unknown> | undefined;
  /** The params exactly as they arrived, for a failure message worth reading. */
  readonly raw: unknown;
}

export function readCapturedFrame(params: unknown): CapturedFrame {
  const outer = asRecord(params);
  const update = asRecord(outer?.["update"]);
  const content = asRecord(update?.["content"]);
  const text = content?.["text"];
  const sessionId = outer?.["sessionId"];
  const sessionUpdate = update?.["sessionUpdate"];
  return {
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    sessionUpdate: typeof sessionUpdate === "string" ? sessionUpdate : undefined,
    text: typeof text === "string" ? text : undefined,
    meta: asRecord(update?.["_meta"]),
    raw: params,
  };
}

export const readCapturedFrames = (updates: ReadonlyArray<unknown>): ReadonlyArray<CapturedFrame> =>
  updates.map(readCapturedFrame);

/** An `agent_message_chunk` stamped `_meta.source:"slash_command"`. */
export const isSlashCommandFrame = (frame: CapturedFrame): boolean =>
  frame.sessionUpdate === "agent_message_chunk" && frame.meta?.["source"] === "slash_command";

/** An `agent_message_chunk` with NO `_meta` at all — qwen's diagnostic channel. */
export const isBareAgentMessageFrame = (frame: CapturedFrame): boolean =>
  frame.sessionUpdate === "agent_message_chunk" &&
  (frame.meta === undefined || Object.keys(frame.meta).length === 0);

/** The dedicated empty-text usage frame (`_meta.usage`). */
export const isUsageFrame = (frame: CapturedFrame): boolean =>
  frame.sessionUpdate === "agent_message_chunk" && asRecord(frame.meta?.["usage"]) !== undefined;

export const usageInputTokens = (frame: CapturedFrame): number | undefined => {
  const usage = asRecord(frame.meta?.["usage"]);
  const inputTokens = usage?.["inputTokens"];
  return typeof inputTokens === "number" ? inputTokens : undefined;
};

/** Every distinct `_meta` key the capture carried, sorted — a drift tripwire. */
export const metaKeysSeen = (frames: ReadonlyArray<CapturedFrame>): ReadonlyArray<string> =>
  [...new Set(frames.flatMap((frame) => Object.keys(frame.meta ?? {})))].sort();
