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

/**
 * ru-code (S99): qwen's per-session context report (qwen acp-bridge/src/status.ts:108). With
 * `detail: true` (the parameter qwen reads, acp-integration/acpAgent.ts:7440-7441 — `showDetails`
 * is ignored) it lists the tools the model is offered, each `{name, tokens}`. Until every MCP
 * server has loaded it can list tools the next request does not carry yet (S94 P-80): debugging
 * only.
 */
export const QWEN_SESSION_CONTEXT_USAGE_METHOD = "qwen/status/session/context_usage";

/** The tool names in a `context_usage {detail: true}` answer; null when the shape is not it. */
export function readQwenAvailableToolNames(answer: unknown): {
  readonly builtinTools: ReadonlyArray<string>;
  readonly mcpTools: ReadonlyArray<string>;
} | null {
  const usage = asRecord(asRecord(answer)?.["usage"]);
  if (usage === null) return null;
  const names = (list: unknown): ReadonlyArray<string> =>
    Array.isArray(list)
      ? list.flatMap((entry) => {
          const name = asRecord(entry)?.["name"];
          return typeof name === "string" ? [name] : [];
        })
      : [];
  return { builtinTools: names(usage["builtinTools"]), mcpTools: names(usage["mcpTools"]) };
}
