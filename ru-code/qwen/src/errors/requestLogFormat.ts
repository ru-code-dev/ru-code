// ru-code: log-formatting helpers for the `[cli-acp.request.failed]`
// breadcrumb. Kept out of the shared `CliAdapter` so upstream re-syncs stay
// clean — the adapter just imports and calls these.

import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** The composed message of a failure, or its string form — never a stack. */
const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
};

/**
 * Present a failed RPC by its meaningful fields, never a stack. In a bundled
 * build the stack frames are always useless `Mime-*.mjs` / `bin.mjs` internals
 * (no CLI-side frames — the agent doesn't send a stack), so we drop them:
 *  - `AcpRequestError` → `code` + `message` + `data.details`.
 *  - anything else (transport death, process exit, defect) → the composed
 *    `.message` chain (each Acp/* error's getter embeds its inner cause's
 *    message), which carries the whole story without the mime stack.
 */
export const describeRequestFailure = (cause: Cause.Cause<unknown>): Record<string, unknown> => {
  const error = Cause.squash(cause);
  if (!isAcpRequestError(error)) {
    return { cause: messageOf(error) };
  }
  const data = error.data;
  const details =
    typeof data === "object" &&
    data !== null &&
    "details" in data &&
    typeof data.details === "string"
      ? data.details
      : undefined;
  return {
    code: error.code,
    message: error.errorMessage,
    ...(details !== undefined ? { details } : {}),
  };
};

// A prompt content block can carry a base64 image attachment (MBs) and raw user
// text — neither belongs verbatim in an error breadcrumb. Summarize each block
// to a single STRING ("text: …", "image: image/png") rather than a nested
// object: the log pretty-printer truncates objects past depth 2 to `[Object]`,
// but string leaves are always printed in full. Heavy `data` is dropped.
const MAX_PROMPT_PREVIEW = 120;

const describePromptPart = (part: unknown): string => {
  if (typeof part !== "object" || part === null || !("type" in part)) return String(part);
  const type = String((part as { readonly type: unknown }).type);
  const text = (part as { readonly text?: unknown }).text;
  if (type === "text" && typeof text === "string") {
    const preview =
      text.length > MAX_PROMPT_PREVIEW ? `${text.slice(0, MAX_PROMPT_PREVIEW)}…` : text;
    return `text: ${preview}`;
  }
  const mimeType = (part as { readonly mimeType?: unknown }).mimeType;
  return typeof mimeType === "string" ? `${type}: ${mimeType}` : type;
};

/** Summarize a request payload's `prompt` blocks; non-prompt payloads pass through. */
export const describeRequestPayload = (payload: unknown): unknown => {
  if (typeof payload !== "object" || payload === null || !("prompt" in payload)) return payload;
  const prompt = (payload as { readonly prompt: unknown }).prompt;
  return Array.isArray(prompt)
    ? { ...(payload as object), prompt: prompt.map(describePromptPart) }
    : payload;
};
