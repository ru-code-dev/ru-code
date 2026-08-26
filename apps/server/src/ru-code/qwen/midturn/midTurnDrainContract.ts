// ru-code (mid-turn wave, phase 3): the SHARED wire contract for
// `craft/drainMidTurnQueue` — the handful of bytes that production and the test
// transcription must agree on exactly.
//
// DRY note: the full 1:1 transcription of qwen's drain CALLER (its validity
// rule, permanent-failure rule, prefix, fold and response reader) lives in the
// test tree at
// `apps/server/src/ru-code/tests/qwen/fake-acp/qwen021MidTurnDrain.ts`, because
// it models the AGENT's behaviour and only the fake needs it. The values below
// are the ones BOTH sides need, so they are defined here once and imported
// there — a method name or a cap that disagreed between our responder and the
// fake would make the whole matrix vacuous.
//
// Pins are at qwen v0.21.1 = 41b4ee8373fb4aa324925e69e0515ca72959ec5b:
//   Session.ts = packages/cli/src/acp-integration/session/Session.ts
import type * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

/** acp-bridge/src/bridgeTypes.ts:578 — `MID_TURN_QUEUE_DRAIN_METHOD`. */
export const QWEN_MID_TURN_DRAIN_METHOD = "craft/drainMidTurnQueue";

/**
 * Session.ts:523 — `MAX_MID_TURN_DRAIN_ITEMS = 10`.
 *
 * qwen's `capMidTurnDrainItems` (Session.ts:662-669) does `items.slice(0, 10)`
 * and DISCARDS the surplus rather than deferring it. Because answering a drain
 * means splicing our own queue, an eleven-item answer would lose the eleventh
 * message in both places at once. We therefore cap our own answer and keep the
 * remainder queued — see `MidTurnQueue.takeForDrain`.
 */
export const QWEN_MAX_MID_TURN_DRAIN_ITEMS = 10;

/**
 * The params qwen sends. Session.ts:4707-4712 — `sessionId` always;
 * `todoStopGuardWatchQueuedPrompt` only on the todoStopGuard call sites
 * (Session.ts:3301, :3400, :3665).
 *
 * Decoded by `handleExtRequest` before our handler runs
 * (effect-acp `_internal/shared.ts:44-53`), which is precisely why the
 * responder is registered by EXACT METHOD NAME with this schema rather than via
 * `handleUnknownExtRequest`: the unknown-fallback would answer every
 * unregistered vendor method with a drain response instead of letting it
 * reject with -32601.
 */
export const MidTurnDrainRequest = Schema.Struct({
  sessionId: Schema.String,
  todoStopGuardWatchQueuedPrompt: Schema.optional(Schema.Boolean),
});

/**
 * One item of the answer. `content` must be a NON-EMPTY ContentBlock array.
 *
 * ru-code (phase 4, M1): widened from text-only to the full block union. qwen's
 * `isContentBlock` (Session.ts:558-584) accepts `image` and `audio` blocks and
 * rejects only `resource_link`, so text-only was our limitation, not the
 * protocol's — and it meant an attachment was dropped while the balloon
 * reported delivered.
 */
export interface MidTurnDrainResponseItem {
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly displayText: string;
}

/**
 * The answer envelope.
 *
 * `items` is ALWAYS present, even when empty. `isValidMidTurnDrainResponse`
 * (Session.ts:769-796) returns true for `{items: []}` — `[].every(…)` is
 * vacuously true — but FALSE for `{}`, which matches neither the `items` nor
 * the `messages` branch and falls through to `return false`. An invalid answer
 * still delivers its messages (Session.ts:4731-4736) but flips `reliable`,
 * which gates qwen's todoStopGuard (Session.ts:3339, :3438, :3721). So the
 * empty answer is `{items: [], hasQueuedPrompt: false}`, never `{}`.
 */
export interface MidTurnDrainResponse {
  readonly items: ReadonlyArray<MidTurnDrainResponseItem>;
  readonly hasQueuedPrompt: boolean;
}

/**
 * Build one answer item from a queued message's resolved blocks.
 *
 * `displayText` is what qwen logs and what it falls back to if resolving the
 * blocks fails (Session.ts:4866-4867, :4892); it is NOT the payload. An
 * attachment-only message has no text, so it gets a stable placeholder rather
 * than an empty string — qwen substitutes its own
 * `"[User message with attachments]"` for a blank one anyway
 * (Session.ts:704-722), and matching that intent here keeps our logs readable.
 */
export const midTurnDrainItem = (input: {
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly text: string;
}): MidTurnDrainResponseItem => ({
  content: input.content,
  displayText: input.text.trim().length > 0 ? input.text : "[User message with attachments]",
});

// ── The SECOND ext-method qwen calls, and why we must answer it ──────────────

/**
 * acp-bridge/src/bridgeTypes.ts:585-586 —
 * `TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD`.
 *
 * ru-code (phase 4b, FR3): the trigger is WIDER than an earlier version of this
 * comment claimed. It is not only "a watch-flag drain answered
 * `hasQueuedPrompt: true`". There are SIX call sites — `Session.ts:3307, 3342,
 * 3406, 3441, 3674, 3742` — plus one at `:3817-3831` that is UNCONDITIONAL: it
 * runs on EVERY Todo Stop Guard continuation send, with no `hasQueuedPrompt`
 * precondition at all. So the method is called on sessions where our queue is
 * always empty, and the default arm below is the one production actually takes.
 *
 * Those drains are in any case not exotic: the site at Session.ts:3301 is
 * reached at ordinary TURN END on the no-pending-tool-calls branch, gated only
 * by `todoStopGuard.needsStopInspection` — which any successful `TodoWrite`
 * arms. A model that writes a todo list, i.e. routine qwen behaviour, reaches it.
 *
 * If we do not answer, `dispatchExtRequest` rejects `-32601`
 * (effect-acp client.ts:390-397), the claim resolves `'unavailable'`
 * (Session.ts:1547-1575) and qwen calls `blockUntilOrdinaryPromptStarts()` —
 * `clearTrust()` + `#suspended = true`, killing its todo auto-continuation for
 * the REST OF THE SESSION, silently.
 */
export const QWEN_TODO_STOP_GUARD_CLAIM_METHOD = "craft/claimTodoStopGuardContinuation";

/** Params qwen sends. Session.ts:1536-1542 — `promptId` only when it owns one. */
export const TodoStopGuardClaimRequest = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
});

export interface TodoStopGuardClaimResponse {
  readonly claimed: boolean;
  readonly hasQueuedPrompt: boolean;
}

/**
 * Our answer, and the reasoning for each arm (Session.ts:1552-1575):
 *
 * - **We have queued messages AND qwen owns a promptId** → `{claimed: false,
 *   hasQueuedPrompt: true}`. qwen resolves `'queued'`, preserves the drained
 *   parts and returns `end_turn` — then our turn-end flush sends them as the
 *   next prompt. That is precisely what we were going to do anyway, so this arm
 *   is honest rather than merely safe.
 * - **Anything else** → `{claimed: true, hasQueuedPrompt: false}`. qwen resolves
 *   `'claimed'` and calls `resumeTrustedPrompt()`, i.e. carries on exactly as it
 *   would with no host involvement.
 *
 * What we must NEVER return is a shape that falls through to `'unavailable'` —
 * `{claimed:false, hasQueuedPrompt:false}` does, and so does the `true`/no-promptId
 * combination, because the `'queued'` branch is guarded on `ownerPromptId`. Both
 * hard-suspend the guard. The rule is therefore: only claim `hasQueuedPrompt:
 * true` when qwen gave us a promptId to hang it on.
 */
export const todoStopGuardClaimResponse = (input: {
  readonly queuedCount: number;
  readonly promptId: string | undefined;
}): TodoStopGuardClaimResponse =>
  input.queuedCount > 0 && input.promptId !== undefined
    ? { claimed: false, hasQueuedPrompt: true }
    : { claimed: true, hasQueuedPrompt: false };
