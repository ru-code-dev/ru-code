// ru-code (mid-turn wave, phase 4 — SB6): the transcribed drain rules, driven
// POSITIVELY.
//
// The e2e matrix only ever asserts the happy values (`timeoutStrikes === 0`,
// `permanentlyDisabled === false`) — which a transcription that had LOST its
// strike logic would also produce. Contract rows 3, 7, 18 and 19 were therefore
// pinned only in the negative. These drive each rule to its firing point.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { todoStopGuardClaimResponse } from "../../../qwen/midturn/midTurnDrainContract.ts";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  QWEN_MID_TURN_DRAIN_MAX_TIMEOUT_STRIKES,
  qwenIsPermanentDrainFailure,
  qwenIsValidDrainResponse,
  qwenReadDrainedContent,
  qwenReadDrainedTexts,
} from "../fake-acp/qwen021MidTurnDrain.ts";

// ── row 18/19: when does qwen give up on us FOREVER? ─────────────────────────

it.effect("SB6: a -32601 reply latches permanently on the FIRST strike", () =>
  Effect.sync(() => {
    // Session.ts:4775 — `errorCode === -32601` is checked before any strike
    // arithmetic, so one is enough.
    assert.isTrue(
      qwenIsPermanentDrainFailure({
        errorCode: JSON_RPC_METHOD_NOT_FOUND,
        isTimeout: false,
        consecutiveTimeoutStrikes: 0,
      }),
    );
  }),
);

it.effect("SB6: an error message merely CONTAINING 'method not found' also latches", () =>
  Effect.sync(() => {
    // Session.ts:4776 — the regex arm. This is why nothing on our side may ever
    // put that phrase in an error string: it permanently kills the channel.
    assert.isTrue(
      qwenIsPermanentDrainFailure({
        errorMessage: "upstream said: Method Not Found (while proxying)",
        isTimeout: false,
        consecutiveTimeoutStrikes: 0,
      }),
    );
  }),
);

it.effect("SB6: timeouts latch on the THIRD consecutive strike, not the first or second", () =>
  Effect.sync(() => {
    const at = (strikes: number) =>
      qwenIsPermanentDrainFailure({ isTimeout: true, consecutiveTimeoutStrikes: strikes });
    assert.isFalse(at(1), "one slow answer must stay transient");
    assert.isFalse(at(2), "two must still be transient");
    assert.isTrue(at(QWEN_MID_TURN_DRAIN_MAX_TIMEOUT_STRIKES), "the third latches");
    assert.strictEqual(QWEN_MID_TURN_DRAIN_MAX_TIMEOUT_STRIKES, 3);
  }),
);

it.effect("SB6: a successful answer is never a permanent failure", () =>
  Effect.sync(() => {
    assert.isFalse(qwenIsPermanentDrainFailure({ isTimeout: false, consecutiveTimeoutStrikes: 0 }));
  }),
);

// ── row 11/14: the validity rule, both directions ───────────────────────────

it.effect("SB6: `{items: []}` is VALID but `{}` is not", () =>
  Effect.sync(() => {
    assert.isTrue(qwenIsValidDrainResponse({ items: [], hasQueuedPrompt: false }, false));
    // `{}` reaches neither branch and falls through to `return false`
    // (Session.ts:769-796) — which flips `reliable` and blocks the todo guard.
    assert.isFalse(qwenIsValidDrainResponse({}, false));
  }),
);

it.effect("SB6: under the watch flag, a missing hasQueuedPrompt is INVALID", () =>
  Effect.sync(() => {
    assert.isFalse(qwenIsValidDrainResponse({ items: [] }, true));
    assert.isTrue(qwenIsValidDrainResponse({ items: [], hasQueuedPrompt: false }, true));
  }),
);

it.effect("SB6: the legacy `messages: string[]` dialect is accepted, and `items` shadows it", () =>
  Effect.sync(() => {
    // Session.ts:791-796 — a THIRD accepted shape the transcription did not
    // carry until this round (phase-4 contract addendum).
    assert.isTrue(qwenIsValidDrainResponse({ messages: ["hi"] }, false));
    // When both are present, `items` wins: the `items` branch returns first.
    assert.deepStrictEqual(qwenReadDrainedTexts({ items: [], messages: ["ignored"] }), []);
  }),
);

// ── row 4/17: the cap, and what a drain actually carries ────────────────────

it.effect("SB6: image blocks survive the read; resource_link is rejected", () =>
  Effect.sync(() => {
    const content = qwenReadDrainedContent({
      items: [
        {
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
            { type: "resource_link", uri: "file:///x" },
          ],
          displayText: "look",
        },
      ],
    });
    const blocks = content.flat();
    assert.strictEqual(blocks.length, 2, "resource_link is dropped (Session.ts:577)");
    assert.isTrue(blocks.some((block) => block.type === "image"));
  }),
);

// ── FR3b: the claim response — including the arm production actually takes ───

it.effect("FR3: with NO promptId (the production case) we answer the neutral claim", () =>
  Effect.sync(() => {
    // qwen only sends `promptId` when `getInvocationContext()` yields a context,
    // which needs QWEN_CODE_PRIVATE_ACP_CAPABILITY negotiated in
    // `initialize._meta` plus a `qwen-code/invocation` block on session/prompt
    // (acpAgent.ts:4845-4871). Our host does NONE of that — grep for those
    // symbols over apps/server and packages/effect-acp returns zero — so
    // `promptId` is ALWAYS absent in production and THIS is the arm that runs.
    // A7 pins the other one; before this spec the production arm was unasserted.
    assert.deepStrictEqual(todoStopGuardClaimResponse({ queuedCount: 0, promptId: undefined }), {
      claimed: true,
      hasQueuedPrompt: false,
    });
    // Even with a non-empty queue: without a promptId, claiming `hasQueuedPrompt`
    // would fall through to 'unavailable' and HARD-SUSPEND the guard, because
    // the 'queued' branch is gated on ownerPromptId (Session.ts:1552-1563).
    assert.deepStrictEqual(todoStopGuardClaimResponse({ queuedCount: 7, promptId: undefined }), {
      claimed: true,
      hasQueuedPrompt: false,
    });
  }),
);

it.effect("FR3: with a promptId AND a non-empty queue we hand the turn back", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(todoStopGuardClaimResponse({ queuedCount: 2, promptId: "p1" }), {
      claimed: false,
      hasQueuedPrompt: true,
    });
  }),
);

it.effect("FR3: with a promptId but an EMPTY queue we still answer neutrally", () =>
  Effect.sync(() => {
    // `{claimed:false, hasQueuedPrompt:false}` would fall through to
    // 'unavailable' (Session.ts:1575) — the hard suspend. Never emit it.
    assert.deepStrictEqual(todoStopGuardClaimResponse({ queuedCount: 0, promptId: "p1" }), {
      claimed: true,
      hasQueuedPrompt: false,
    });
  }),
);
