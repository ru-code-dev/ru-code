// ru-code: qwen is a plain JSON-RPC agent, so its error responses to core RPC
// methods (session/prompt, session/new, …) arrive at the client's exit handler
// as a `Die` whose `defect` is the raw `{ code, message, data }` protocol error.
// Effect's RpcClient then decodes that Die through `Schema.Defect` into a bare
// `Error(message)` — dropping `code` and `data` — so the failure reaches the
// qwen adapter as an opaque defect and the recognizer registry can only bucket
// it as E (generic "unexpected server error"), even though every A-bucket
// recognizer (A2 rate limit, A3 generic -32603, A5 auth, …) is keyed on exactly
// that lost `code`/`data`.
//
// Rewriting the protocol-error `Die` into a `Fail` entry makes the RpcClient
// decode it via the method's declared `error` schema instead; the client's
// callRpc then maps it to `AcpRequestError.fromProtocolError`, preserving
// `code` + `data.details`, and the classifier surfaces qwen's real message.
// Only protocol-shaped defects (numeric `code` + string `message`) are touched —
// genuine JS/Node defects and interrupts pass through untouched.
//
// This lives in the shared effect-acp package because it is the ONLY point where
// the raw Die is still intact: by the time control reaches the qwen zone the Die
// has already been decoded to a bare `Error`, so the coercion cannot live in our
// adapter. protocol.ts wires it in with a single marked call (the seam); the
// logic stays here in our tree.
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

/** True when `value` is a JSON-RPC protocol error object (numeric `code` + string `message`). */
export const isProtocolErrorDefect = (
  value: unknown,
): value is { readonly code: number; readonly message: string; readonly data?: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof (value as { code: unknown }).code === "number" &&
  "message" in value &&
  typeof (value as { message: unknown }).message === "string";

/**
 * Rewrite any protocol-shaped `Die` entry in a failed Exit message's cause into a
 * `Fail` entry, so the upstream RpcClient decodes it as a typed protocol error
 * (preserving `code`/`data`) rather than a bare defect. Returns the message
 * unchanged (by identity) when there is nothing to rewrite.
 */
export const coerceProtocolErrorDefects = (
  message: RpcMessage.ResponseExitEncoded,
): RpcMessage.ResponseExitEncoded => {
  if (message.exit._tag !== "Failure") return message;
  let rewrote = false;
  const cause = message.exit.cause.map((entry) => {
    if (entry._tag === "Die" && isProtocolErrorDefect(entry.defect)) {
      rewrote = true;
      return { _tag: "Fail" as const, error: entry.defect };
    }
    return entry;
  });
  return rewrote ? { ...message, exit: { _tag: "Failure" as const, cause } } : message;
};
