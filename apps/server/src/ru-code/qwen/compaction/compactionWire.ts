// ru-code (qwen-compression wave): THE COMPACTION WIRE READERS.
//
// qwen 0.21.1 reports every compaction as PROSE on an ordinary `session/update`
// `agent_message_chunk`. There is no structured field anywhere — not on the
// notification, not in `_meta` (WORKFLOW/02 §2.5). Two shapes exist:
//
//   manual `/compress`  →  "Compressing context..." then
//                          "Context compressed (152340 -> 18211)."
//                          both tagged `_meta.source:"slash_command"`
//                          (qwen compressCommand.ts:97-112, Session.ts:8478-8480,
//                           MessageEmitter.ts:152-165)
//   qwen auto-compaction →  "IMPORTANT: This conversation approached the input
//                          token limit for <model>. A compressed context will be
//                          sent for future messages (compressed from: 190000 to
//                          12345 tokens)."
//                          on a BARE chunk — no `_meta` at all
//                          (qwen Session.ts:4378-4392, :4436-4440, :4668-4673)
//   over the session cap →  "Session token limit exceeded: <n> tokens > <limit>
//                          limit. …" on the same bare channel, then
//                          `stopReason:"max_tokens"` (qwen Session.ts:4418-4434)
//
// The parser is deliberately LOOSE — one rule for every shape and every future
// rewording — and the SAFETY comes from the GATE, not from the text: a tagged
// chunk is always a slash-command report, and a bare chunk is only a compaction
// notice when it is the OPENING agent message of a turn, because qwen compresses
// BEFORE the model send (Session.ts:4363-4372). Model prose that merely mentions
// compressing ("compressed 200 files into 3") therefore cannot be mistaken for a
// compaction: it arrives after the turn has already produced output.
//
// NO SIZE CHECK. An inflated result (post >= pre) is a real, confirmed
// compaction — qwen has a dedicated status for it
// (`COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`, turn.ts:311) and reports it to the
// ACP client as an ordinary success line (WORKFLOW/02 §2.2 "Trap"). The adapter's
// low-gain / circuit-breaker branches are what judge the numbers.

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Integers, thousands separators allowed, NEVER glued to a letter or another
 * digit.
 *
 * The letter guard is not cosmetic: qwen interpolates the MODEL NAME into the
 * auto-compaction notice ahead of the numbers ("…for qwen3-coder-plus…",
 * Session.ts:4383-4386), so a bare `\d+` scan reads the `3` of `qwen3` as the
 * pre-compaction size. Separators cover the locales a host could ever render
 * (comma, space, NBSP, narrow NBSP, thin space, apostrophe) but deliberately NOT
 * the full stop: qwen never localizes these numbers (`t()` is not applied —
 * compressCommand.ts:109-112), so "." can only ever arrive as a decimal point or
 * a version fragment, where reading it as a separator would invent a number.
 * A digit run that touches a dot on its digit side ("0.211") is dropped whole
 * for the same reason — half of a decimal is not a token count — while a count
 * that merely ends a sentence ("… to 12345.") still reads.
 */
const INTEGER =
  /(?<![\p{L}\d]|\d\.)(?:\d{1,3}(?:[ \u00A0\u202F\u2009,']\d{3})+|\d+)(?![\p{L}\d]|\.\d)/gu;

const SEPARATORS = /[ \u00A0\u202F\u2009,']/g;

/**
 * THE INVARIANT HEADS of qwen's two bare diagnostics — the only fixed prefixes
 * `#sendMessageStreamWithAutoCompression` builds around its interpolations.
 *
 * WHY THEY EXIST HERE. That method runs before EVERY model send of a turn, not
 * just the first: the turn loop calls it again for each tool-result
 * continuation (`Session.ts:3602` → `:3655`, and `:2970`, `:5319`, `:5829`), and
 * the notice is emitted from whichever send compacted (`:4437-4441`). So in the
 * ordinary agentic shape — text → tool call → tool result → the continuation
 * compacts — the notice arrives AFTER the turn has already spoken, where
 * "the turn's opening agent message" can no longer identify it.
 *
 * A head match is what identifies it there. Both strings are the emitter's own
 * literal prefix with no interpolation before it (`Session.ts:4388` builds
 * `IMPORTANT: This conversation ${reasonClause}…`; `:4428` builds
 * `Session token limit exceeded: ${n} tokens > …`), so matching the head is as
 * strong as matching the whole template and survives any reword of the middle.
 *
 * They are deliberately NOT what the parser keys on. The parser stays loose (one
 * rule for every shape); these only widen WHEN a bare chunk may be read, and
 * they fail closed: model prose that merely mentions compressing carries neither
 * head, so mid-turn it is handed back to the chat untouched.
 */
export const QWEN_AUTO_COMPACTION_HEAD = "IMPORTANT: This conversation ";
export const QWEN_SESSION_LIMIT_HEAD = "Session token limit exceeded: ";

/**
 * Does `text` open with one of qwen's diagnostic heads? The second admission
 * path for a BARE chunk, beside "it is the turn's opening agent message".
 */
export function hasQwenDiagnosticHead(text: string): boolean {
  return text.startsWith(QWEN_AUTO_COMPACTION_HEAD) || text.startsWith(QWEN_SESSION_LIMIT_HEAD);
}

/** What a compaction-bearing chunk says. */
export type QwenCompactionSignal =
  /** "Compressing context..." — the work started, no numbers yet. */
  | { readonly kind: "progress" }
  /** A completed compaction and its two token counts, in wire order. */
  | { readonly kind: "result"; readonly preTokens: number; readonly postTokens: number }
  /** Compaction happened but the prompt still exceeds the session cap. */
  | { readonly kind: "session-limit" };

/**
 * Read a compaction report out of an agent chunk's text, or `undefined` when the
 * text is not one.
 *
 * Numbers are taken from the tail that follows the LAST "compress" in the text.
 * Both wire shapes put the counts after their final "compress"
 * ("Context compressed (X -> Y)." / "…(compressed from: X to Y tokens)."), and
 * anchoring there is what keeps a model name, a file path or a version number
 * that precedes the sentence out of the reading.
 */
export function parseQwenCompactionText(text: string): QwenCompactionSignal | undefined {
  const lower = text.toLowerCase();
  // Checked first and independently: qwen's session-cap notice does NOT contain
  // the word "compress" at all (Session.ts:4427-4431).
  if (lower.includes("session token limit")) return { kind: "session-limit" };
  const anchor = lower.lastIndexOf("compress");
  if (anchor < 0) return undefined;
  const numbers: Array<number> = [];
  for (const match of text.slice(anchor).matchAll(INTEGER)) {
    const parsed = Number(match[0].replace(SEPARATORS, ""));
    if (!Number.isFinite(parsed)) continue;
    numbers.push(parsed);
    if (numbers.length === 2) break;
  }
  const [preTokens, postTokens] = numbers;
  if (preTokens === undefined || postTokens === undefined) return { kind: "progress" };
  return { kind: "result", preTokens, postTokens };
}

/**
 * True for a chunk qwen stamped as slash-command output —
 * `update._meta.source === "slash_command"` (MessageEmitter.ts:152-165). This is
 * the ONLY marker that separates a `/compress` report from the model talking at
 * 0.21.1, and it is always trustworthy: nothing else in the CLI sets it.
 */
export function isQwenSlashCommandFrame(rawPayload: unknown): boolean {
  const update = asRecord(asRecord(rawPayload)?.["update"]);
  const meta = asRecord(update?.["_meta"]);
  return meta !== null && meta["source"] === "slash_command";
}

/**
 * True for a chunk carrying NO `_meta` at all — qwen's diagnostic channel
 * (Session.ts:4668-4673), which is byte-identical to an ordinary assistant
 * chunk. Deliberately stricter than "no `_meta.source`": a sub-agent's text
 * carries `_meta.parentToolCallId` and a usage frame carries `_meta.usage`, and
 * neither is ever the parent session's compaction notice.
 */
export function isQwenBareAgentFrame(rawPayload: unknown): boolean {
  const update = asRecord(asRecord(rawPayload)?.["update"]);
  if (update === null) return false;
  const meta = asRecord(update["_meta"]);
  return meta === null || Object.keys(meta).length === 0;
}
