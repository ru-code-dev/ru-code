// ru-code (mid-turn wave, phase 4d): the dispatch-claim invariant, pinned.
//
// Round 4's finding: reverting the owner-matched release, or deleting the loser
// branch's return, reddened NOTHING in the black-box suite. That was not a suite
// weakness — those paths are UNREACHABLE on the current tree, because a
// compaction cannot start while a claim is held and a claim is never taken while
// a compaction is active, so the one failure that could fire between the claim
// and `activeCtx` being assigned cannot fire on a claiming turn.
//
// Unreachable-by-construction is exactly what a black-box test cannot see. These
// pin the mechanism instead: they fail the moment the owner check or the mutual
// exclusion is removed, whether or not any current caller can reach the bad path.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  claimDispatchSlot,
  isDispatchSlotHeld,
  releaseDispatchSlot,
  type DispatchSlot,
} from "../../../qwen/midturn/dispatchClaim.ts";

const freeSlot = (): DispatchSlot => ({ turnDispatchOwner: undefined });

it.effect("a free slot is claimable, and claiming marks it held", () =>
  Effect.sync(() => {
    const slot = freeSlot();
    assert.isFalse(isDispatchSlotHeld(slot));
    assert.isTrue(claimDispatchSlot(slot, "turn-1"));
    assert.isTrue(isDispatchSlotHeld(slot));
  }),
);

it.effect("MUTUAL EXCLUSION: a held slot cannot be claimed by anyone else", () =>
  Effect.sync(() => {
    // What stops two producers of `session/prompt` — a turn, the turn-end flush,
    // and compaction — dispatching at once. A second prompt on a live session
    // aborts the first (qwen Session.ts:2285).
    const slot = freeSlot();
    assert.isTrue(claimDispatchSlot(slot, "turn-1"));
    assert.isFalse(claimDispatchSlot(slot, "turn-2"), "the second claimant must be refused");
    assert.strictEqual(slot.turnDispatchOwner, "turn-1", "and must not overwrite the owner");
  }),
);

it.effect("OWNER MATCH: a non-owner cannot release someone else's claim", () =>
  Effect.sync(() => {
    // FRESH-C's defect in one line: a turn that never claimed reaching its own
    // `finalize` and freeing the real claimant's slot.
    const slot = freeSlot();
    claimDispatchSlot(slot, "turn-1");
    assert.isFalse(releaseDispatchSlot(slot, "turn-2"), "a non-owner release must be refused");
    assert.strictEqual(slot.turnDispatchOwner, "turn-1", "the claim must survive");
  }),
);

it.effect("the owner releases, and the slot becomes claimable again", () =>
  Effect.sync(() => {
    const slot = freeSlot();
    claimDispatchSlot(slot, "turn-1");
    assert.isTrue(releaseDispatchSlot(slot, "turn-1"));
    assert.isFalse(isDispatchSlotHeld(slot));
    assert.isTrue(claimDispatchSlot(slot, "turn-2"), "a released slot is free for the next turn");
  }),
);

it.effect("a stale token must never free the NEW owner's claim", () =>
  Effect.sync(() => {
    const slot = freeSlot();
    claimDispatchSlot(slot, "turn-1");
    assert.isTrue(releaseDispatchSlot(slot, "turn-1"));
    assert.isFalse(releaseDispatchSlot(slot, "turn-1"), "the second release does nothing");

    claimDispatchSlot(slot, "turn-2");
    assert.isFalse(releaseDispatchSlot(slot, "turn-1"), "a stale token must not free turn-2");
    assert.strictEqual(slot.turnDispatchOwner, "turn-2");
  }),
);

// ── FRESH-I — the CALLER must route off the refusal ─────────────────────────
//
// Round 5, criterion clause 2: the adapter used to pre-check the field inline
// and then call `claimDispatchSlot` while DISCARDING its return. So the dispatch
// decision consulted the adapter's own copy of the exclusion rule rather than
// the primitive's — which is why removing mutual exclusion from the primitive
// left the adapter suite fully green — and on a refusal a claim would have been
// recorded as held.
//
// This models the caller's contract in one place: attempting the claim IS the
// decision, and a refusal must produce no recorded claim.

interface CallerOutcome {
  readonly dispatched: boolean;
  readonly recordedClaim: string | undefined;
}

/** The shape `sendTurnInternal` now runs: claim-or-route, never both. */
const runCaller = (slot: DispatchSlot, token: string): CallerOutcome => {
  if (!claimDispatchSlot(slot, token)) {
    return { dispatched: false, recordedClaim: undefined };
  }
  return { dispatched: true, recordedClaim: token };
};

it.effect("FRESH-I: a REFUSED claim routes to the loser path and records nothing", () =>
  Effect.sync(() => {
    const slot = freeSlot();
    claimDispatchSlot(slot, "turn-1");

    const loser = runCaller(slot, "turn-2");
    assert.isFalse(loser.dispatched, "a refused claimant must NOT dispatch — that is the O1 abort");
    assert.isUndefined(
      loser.recordedClaim,
      "and must not record a claim it does not hold, or its finalize would release the owner's",
    );
    assert.strictEqual(slot.turnDispatchOwner, "turn-1", "the real owner is untouched");
  }),
);

it.effect("FRESH-I: an ACCEPTED claim dispatches and records exactly its own token", () =>
  Effect.sync(() => {
    const slot = freeSlot();
    const winner = runCaller(slot, "turn-1");
    assert.isTrue(winner.dispatched);
    assert.strictEqual(winner.recordedClaim, "turn-1");
    assert.strictEqual(slot.turnDispatchOwner, "turn-1");
  }),
);
