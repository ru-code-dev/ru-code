// ru-code (mid-turn wave, phase 2): a 1:1 TRANSCRIPTION of qwen 0.21.1's
// MID-TURN DRAIN CALLER. Everything below models what the AGENT does to the
// HOST across `craft/drainMidTurnQueue` — the constants it enforces, the shape
// it accepts, the way it folds our answer into the running turn, and the two
// ways it permanently gives up on us.
//
// Direction matters and is the whole reason this file exists. Every other
// transcription in this folder (qwen021Frames.ts) models qwen EMITTING to us.
// This one models qwen CALLING us and judging our reply — so a mistake here is
// not a wrong fixture byte, it is a wrong belief about a contract we must
// satisfy inside a 2-second budget or lose the channel for the session.
//
// Every constant and rule carries its `file:line` at tag v0.21.1
// (commit 41b4ee8373fb4aa324925e69e0515ca72959ec5b). Nothing here is designed.
// A behavioural difference between this file and qwen's own code is a BUG in
// this file.
//
// Companion mapping table (scenario → builder line → capability-doc § → qwen
// src line): WORKFLOW/wave-midturn-mapping-table.md.
//
// qwen source root for every pin below:
//   /mnt/mac/Users/user/WORKSPACE/Projects/experements/qwen-code @ v0.21.1
//   Session.ts = packages/cli/src/acp-integration/session/Session.ts
import type * as AcpSchema from "effect-acp/schema";

// ru-code (phase 3): the two values PRODUCTION also needs are defined once, in
// the production zone, and re-exported here. A method name or a cap that
// disagreed between our responder and this fake would make the whole drain
// matrix vacuous — so there is exactly one definition of each.
export {
  QWEN_MAX_MID_TURN_DRAIN_ITEMS,
  QWEN_MID_TURN_DRAIN_METHOD,
} from "../../../qwen/midturn/midTurnDrainContract.ts";
// Only the cap is referenced by the transcription's own helpers; the method
// name is re-exported above for the fake's use, not consumed here.
import { QWEN_MAX_MID_TURN_DRAIN_ITEMS } from "../../../qwen/midturn/midTurnDrainContract.ts";

// ── The constants qwen enforces on us ────────────────────────────────────────

/**
 * Session.ts:516 — `MID_TURN_QUEUE_DRAIN_TIMEOUT_MS = 2_000`.
 * Enforced by `Promise.race` against a `setTimeout` (Session.ts:4713-4722): a
 * slower answer is DISCARDED and counted as a timeout strike, even though it
 * eventually arrives.
 */
export const QWEN_MID_TURN_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Session.ts:531 — `MID_TURN_QUEUE_DRAIN_MAX_TIMEOUT_STRIKES = 3`.
 * Strikes RESET to 0 on any successful answer (Session.ts:4726), so this is
 * three CONSECUTIVE timeouts, not three total.
 */
export const QWEN_MID_TURN_DRAIN_MAX_TIMEOUT_STRIKES = 3;

// Session.ts:523 `MAX_MID_TURN_DRAIN_ITEMS = 10` — THE SHARP EDGE.
// `capMidTurnDrainItems` (Session.ts:662-669) does `items.slice(0, 10)` and
// logs a warning; items 11+ are DISCARDED, not deferred. Since a host answers a
// drain by splicing its own queue, returning more than ten items destroys the
// surplus in both places at once — the host already removed them, qwen never
// reads them. Defined in the production contract (re-exported above) because
// the responder is the side that must obey it.

/**
 * Session.ts:522 — `MID_TURN_QUEUE_RESOLVE_TIMEOUT_MS = 10_000`. The budget for
 * resolving a STRUCTURED item's ContentBlocks (`#resolvePrompt`,
 * Session.ts:4874-4881) — distinct from, and ten times longer than, the 2s
 * budget for answering the drain call itself.
 */
export const QWEN_MID_TURN_RESOLVE_TIMEOUT_MS = 10_000;

/** utils/midTurnUserMessage.ts:10-11 — `MID_TURN_USER_MESSAGE_PREFIX`. */
export const QWEN_MID_TURN_USER_MESSAGE_PREFIX =
  "\n[User message received during tool execution]: ";

/** JSON-RPC "Method not found". Session.ts:4775 classifies it as PERMANENT. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

// ── The response shape qwen accepts ──────────────────────────────────────────

/**
 * One item of the `items[]` form. Session.ts:781-788 requires `content` to be a
 * non-empty array in which EVERY entry passes `isContentBlock`; `displayText`
 * is optional and only used for logging/recording and as the resolve-failure
 * fallback text (Session.ts:4866-4867, :4892).
 */
export interface QwenMidTurnDrainItem {
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly displayText?: string;
}

/**
 * What our responder puts on the wire. `hasQueuedPrompt` is read with a strict
 * `=== true` (Session.ts:4737-4738) and is only REQUIRED to be a boolean when
 * the agent asked for it via `todoStopGuardWatchQueuedPrompt`
 * (Session.ts:773-777).
 */
export interface QwenMidTurnDrainResponse {
  readonly items: ReadonlyArray<QwenMidTurnDrainItem>;
  readonly hasQueuedPrompt: boolean;
}

/** The params qwen sends us. Session.ts:4707-4712. */
export interface QwenMidTurnDrainParams {
  readonly sessionId: string;
  /** Present ONLY on the todoStopGuard paths. Session.ts:4709-4711. */
  readonly todoStopGuardWatchQueuedPrompt?: true;
}

/**
 * The canonical EMPTY answer — what a conforming host returns on the vast
 * majority of drains, since qwen polls at every tool-round boundary of every
 * turn whether or not we have anything.
 *
 * `items` is present and empty ON PURPOSE. `isValidMidTurnDrainResponse`
 * (Session.ts:769-796) returns TRUE for `{items: []}` — `[].every(…)` is
 * vacuously true — but FALSE for `{}`, because that reaches neither the
 * `Array.isArray(response['items'])` branch nor the `messages` branch and falls
 * through to the final `return`. An invalid answer is not fatal (messages still
 * parse, Session.ts:4731-4736) but it flips `reliable` to false, and `reliable`
 * gates the todoStopGuard (Session.ts:3339, :3438, :3721 →
 * `blockUntilOrdinaryPromptStarts()`). So: ALWAYS emit `items`, never `{}`.
 */
export const qwenEmptyDrainResponse = (): QwenMidTurnDrainResponse => ({
  items: [],
  hasQueuedPrompt: false,
});

/** A text-only queued message, the shape our queue produces for a typed line. */
export const qwenTextDrainItem = (text: string): QwenMidTurnDrainItem => ({
  content: [{ type: "text", text }],
  displayText: text,
});

// ── The rules qwen applies to our answer ─────────────────────────────────────

/**
 * Session.ts:769-796 — `isValidMidTurnDrainResponse`, transcribed.
 *
 * NOTE the asymmetry, which is easy to get wrong: `requireQueuedPromptState`
 * only forces `hasQueuedPrompt` to BE a boolean; it never requires it to be
 * true, and it is checked BEFORE the items/messages branches.
 */
export const qwenIsValidDrainResponse = (
  response: unknown,
  requireQueuedPromptState: boolean,
): boolean => {
  if (
    response === null ||
    typeof response !== "object" ||
    (requireQueuedPromptState &&
      typeof (response as Record<string, unknown>)["hasQueuedPrompt"] !== "boolean")
  ) {
    return false;
  }
  const record = response as Record<string, unknown>;
  if (Array.isArray(record["items"])) {
    return record["items"].every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        Array.isArray((item as Record<string, unknown>)["content"]) &&
        ((item as Record<string, unknown>)["content"] as unknown[]).length > 0,
    );
  }
  return (
    Array.isArray(record["messages"]) &&
    record["messages"].every((message) => typeof message === "string" && message.trim().length > 0)
  );
};

/**
 * utils/midTurnUserMessage.ts:13-31 — `prefixMidTurnUserMessageParts`,
 * transcribed for the text case our queue actually produces.
 *
 * The prefix goes on the FIRST part only, and it is applied ONCE PER MESSAGE
 * inside `#buildMidTurnParts`'s loop (Session.ts:4857-4906, prefix call at
 * :4900, `parts.push(...built)` at :4904). That per-message application IS the
 * message-boundary preservation the UX depends on: two queued messages reach
 * the model as two separately-prefixed part groups in one round, never as one
 * concatenated blob.
 */
export const qwenPrefixMidTurnText = (text: string): string =>
  `${QWEN_MID_TURN_USER_MESSAGE_PREFIX}${text}`;

/**
 * What the model ends up seeing for a whole drain, in order — the transcription
 * of `#buildNextMessageAfterToolRun`'s fold (Session.ts:4555-4566, the fold itself at :4562):
 *   `const parts = [...toolRun.parts, ...drained.parts];`
 * i.e. the tool results FIRST, then one prefixed group per drained message, all
 * inside ONE `role:'user'` message on the next model round. No new
 * `session/prompt`, no abort — `pendingPrompt` is never touched on this path.
 */
export const qwenFoldDrainedTexts = (
  toolResultTexts: ReadonlyArray<string>,
  drainedTexts: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...toolResultTexts,
  ...drainedTexts.slice(0, QWEN_MAX_MID_TURN_DRAIN_ITEMS).map(qwenPrefixMidTurnText),
];

/** Session.ts's `isRecord`, inlined so this file stays dependency-free. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Session.ts:724-766 `parseMidTurnDrainResponse` + Session.ts:662-669
 * `capMidTurnDrainItems` + the per-message prefix, composed into the one thing a
 * spec cares about: **the ordered list of texts the model ends up seeing** for a
 * drain, each already prefixed and still its own entry.
 *
 * Transcribed behaviours, in qwen's order:
 *   1. a non-record answer yields nothing (Session.ts:725);
 *   2. `items[]` wins over `messages[]` when present (Session.ts:727-728);
 *   3. the cap is `slice(0, 10)` — surplus is DESTROYED, never deferred;
 *   4. an item whose `content` is not an array is DROPPED with a warning, not
 *      fatal (`getValidMidTurnContentBlocks`, Session.ts:678-702);
 *   5. text is taken from the `type:"text"` blocks, joined with "\n"
 *      (`getStructuredMidTurnDisplayText`, Session.ts:704-722), with
 *      `displayText` preferred when non-blank;
 *   6. each surviving message is prefixed independently.
 */
export const qwenReadDrainedTexts = (response: unknown): ReadonlyArray<string> => {
  if (!isRecord(response)) return [];

  if (Array.isArray(response["items"])) {
    return response["items"].slice(0, QWEN_MAX_MID_TURN_DRAIN_ITEMS).flatMap((item): string[] => {
      if (!isRecord(item)) return [];
      const content = item["content"];
      if (!Array.isArray(content)) return [];
      const displayText = item["displayText"];
      if (typeof displayText === "string" && displayText.trim().length > 0) {
        return [qwenPrefixMidTurnText(displayText.trim())];
      }
      const text = content
        .filter(
          (block): block is { type: "text"; text: string } =>
            isRecord(block) && block["type"] === "text" && typeof block["text"] === "string",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      return [qwenPrefixMidTurnText(text || "[User message with attachments]")];
    });
  }

  if (Array.isArray(response["messages"])) {
    return response["messages"]
      .slice(0, QWEN_MAX_MID_TURN_DRAIN_ITEMS)
      .filter(
        (message): message is string => typeof message === "string" && message.trim().length > 0,
      )
      .map(qwenPrefixMidTurnText);
  }

  return [];
};

/**
 * The RAW `items[].content` arrays, post-cap, exactly as qwen would hand them to
 * `#buildMidTurnParts`. Distinct from {@link qwenReadDrainedTexts}, which
 * collapses each item to its display text and therefore cannot see an image
 * block at all — that blindness is what let attachments be dropped while the
 * mark said delivered (phase-4 finding M1).
 */
export const qwenReadDrainedContent = (
  response: unknown,
): ReadonlyArray<ReadonlyArray<AcpSchema.ContentBlock>> => {
  if (!isRecord(response) || !Array.isArray(response["items"])) return [];
  return response["items"]
    .slice(0, QWEN_MAX_MID_TURN_DRAIN_ITEMS)
    .flatMap((item): Array<ReadonlyArray<AcpSchema.ContentBlock>> => {
      if (!isRecord(item)) return [];
      const content = item["content"];
      if (!Array.isArray(content)) return [];
      // Only blocks qwen's own `isContentBlock` would keep (Session.ts:558-584).
      return [
        content.filter((block): block is AcpSchema.ContentBlock => isQwenContentBlock(block)),
      ];
    });
};

/** Session.ts:558-584 — `isContentBlock`, transcribed. */
const isQwenContentBlock = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  switch (value["type"]) {
    case "text":
      return typeof value["text"] === "string";
    case "image":
      return (
        typeof value["mimeType"] === "string" &&
        value["mimeType"].startsWith("image/") &&
        typeof value["data"] === "string"
      );
    case "audio":
      return (
        typeof value["mimeType"] === "string" &&
        value["mimeType"].startsWith("audio/") &&
        typeof value["data"] === "string"
      );
    // `resource_link` is UNCONDITIONALLY rejected (Session.ts:577).
    case "resource_link":
      return false;
    case "resource":
      return isRecord(value["resource"]);
    default:
      return false;
  }
};

/**
 * Session.ts:4774-4783 — when does qwen give up on us FOREVER (per session)?
 *
 *   - a `-32601` reply, or a message matching `/method not found/i`  → PERMANENT
 *     IMMEDIATELY (one strike, no retries)
 *   - the 3rd CONSECUTIVE timeout                                    → PERMANENT
 *   - a 1st or 2nd timeout                                           → transient
 *
 * Once permanent, `midTurnDrainUnavailable` latches and Session.ts:4697 returns
 * without ever calling us again for that session's lifetime.
 */
export const qwenIsPermanentDrainFailure = (input: {
  readonly errorCode?: number | undefined;
  readonly errorMessage?: string | undefined;
  readonly isTimeout: boolean;
  readonly consecutiveTimeoutStrikes: number;
}): boolean =>
  input.errorCode === JSON_RPC_METHOD_NOT_FOUND ||
  /method not found/i.test(input.errorMessage ?? "") ||
  (input.isTimeout && input.consecutiveTimeoutStrikes >= QWEN_MID_TURN_DRAIN_MAX_TIMEOUT_STRIKES);

// ── Where qwen calls us: all five `#drainMidTurnInput` call sites ────────────

/**
 * Session.ts:4683 is the single implementation; five call sites reach it. A
 * host cannot choose which one fires, so our responder must be correct at all
 * of them — but only the FIRST is the ordinary, every-turn path, and it is the
 * only one the fake models as a scenario. The other four are documented here
 * rather than modelled, with the reason each is out of the fake's reach.
 */
export type QwenDrainCallSite =
  /**
   * Session.ts:4555, inside `#buildNextMessageAfterToolRun`. THE canonical
   * boundary: fires after every completed tool run, on every turn, with
   * `{onFullTurnModel}` only — no todoStopGuard watch, so no `hasQueuedPrompt`
   * requirement. The drained parts are folded into the SAME next-round message
   * as the tool results (:4565). MODELLED by the fake.
   */
  | "tool-round-boundary"
  /**
   * Session.ts:4522, inside `#preserveStoppedToolRun`. The STOP path, and it is
   * conditional: when `abortSignal.aborted` it does NOT drain at all — it only
   * takes messages already recovered from a prior timed-out drain
   * (:4516-4522). So a user Stop does NOT pull our queue. This is the qwen-side
   * half of "stop ⇒ nothing auto-fires"; our half is to reset the queue.
   * DOCUMENTED, not modelled: reaching it requires a stopped tool run, which the
   * fake drives through its own cancel path rather than through a drain.
   */
  | "stopped-tool-run"
  /**
   * Session.ts:3301 and Session.ts:3400 — both inside the todoStopGuard's
   * `needsStopInspection` branches, both with
   * `watchQueuedPromptForTodoStopGuard: true` (so `hasQueuedPrompt` MUST be a
   * boolean or `reliable` goes false). DOCUMENTED, not modelled: they fire only
   * when qwen's TodoStopGuard decides a stop needs inspection, which is
   * internal agent state with no wire surface a host can provoke.
   */
  | "todo-stop-guard-inspection"
  /**
   * Session.ts:3665, inside `#sendMessageStreamWithAutoCompression`'s
   * `prepareBeforeCompression` hook, and only when a guard continuation is
   * active. DOCUMENTED, not modelled — and doubly out of scope: compaction is
   * OWNER-RULED out of this wave (wave-midturn-plan.md).
   */
  | "guard-continuation-precompression";

/**
 * The two params shapes, keyed by call site — the ONLY difference a host can
 * observe between them (Session.ts:4707-4712).
 */
export const qwenDrainParamsFor = (
  sessionId: string,
  callSite: QwenDrainCallSite,
): QwenMidTurnDrainParams =>
  callSite === "tool-round-boundary" || callSite === "stopped-tool-run"
    ? { sessionId }
    : { sessionId, todoStopGuardWatchQueuedPrompt: true };

/**
 * v0.13.1 — the NO-POLLING engine. `git show v0.13.1:…/Session.ts | grep -ci
 * "drainMidTurnQueue"` → 0; `packages/acp-bridge` (which DEFINES the method
 * constant) does not exist at that tag; `packages/cli/src/utils/midTurnUserMessage.ts`
 * does not exist either. There is no drain, no poll, and no way to make one
 * happen — a host talking to a 0.13.1 engine will never be called.
 *
 * This is not a legacy footnote: it is the fallback our UX must degrade into,
 * and it is exactly what the fake's DEFAULT (drain-off) mode reproduces. A
 * queued message on such an engine can only ever be delivered by the host's own
 * turn-end flush as the NEXT `session/prompt`.
 */
export const QWEN_V1_POLLS_MID_TURN = false;
