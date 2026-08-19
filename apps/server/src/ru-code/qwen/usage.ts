// ru-code: extract the running input-token count qwen stamps on each
// `agent_message_chunk`. qwen puts the live promptTokenCount under
// `update._meta.usage.inputTokens` (NOT `totalTokens`, which counts a different
// aggregate) of the raw SessionNotification params. The adapter feeds this to the
// context meter mid-turn so the gauge no longer freezes until /compress.

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Read `rawPayload.update._meta.usage.inputTokens`, guarding every level with a
 * safe record cast. Returns a finite `>= 0` number, or `null` when the field is
 * missing, negative, non-finite, or any level is not a plain object.
 * `totalTokens` is deliberately ignored.
 */
export function extractQwenInputTokens(rawPayload: unknown): number | null {
  const params = asRecord(rawPayload);
  if (params === null) return null;
  const update = asRecord(params["update"]);
  if (update === null) return null;
  const meta = asRecord(update["_meta"]);
  if (meta === null) return null;
  const usage = asRecord(meta["usage"]);
  if (usage === null) return null;
  const inputTokens = usage["inputTokens"];
  if (typeof inputTokens !== "number") return null;
  if (!Number.isFinite(inputTokens)) return null;
  if (inputTokens < 0) return null;
  return inputTokens;
}
