// ru-code (mid-turn wave, phase 4d): the per-thread DISPATCH CLAIM primitives.
//
// Extracted from `QwenAdapter` so the invariant can be pinned directly. Round 4
// proved why that was necessary: reverting the owner-matched release, or
// deleting the loser branch's return, reddened NOTHING in a black-box suite —
// because on the current tree those paths are no longer REACHABLE.
//
// They are unreachable by construction, and the construction is worth stating:
//
//   - a claim is only ever taken when no compaction is active (the claim site
//     skips entirely otherwise), and
//   - a compaction cannot START while a claim is held (its guard refuses), so
//   - the `hiddenCompressActive` fail-fast — the one failure that could fire
//     between the claim and `activeCtx` being assigned — cannot fire on a turn
//     that holds a claim.
//
// So the owner check and the captured-handle release are DEFENCE IN DEPTH: they
// make a whole class of mistake impossible rather than fixing a live bug. That
// is exactly the kind of property a black-box test cannot see and a unit test
// can, which is why these three functions exist as functions at all.
//
// Everything here is synchronous on purpose. The claim's correctness rests on
// CHECK and SET being adjacent with no `yield*` between them — a fiber can only
// be descheduled at a yield point, so adjacency is what makes it atomic.

/** The slice of a session context the claim owns. */
export interface DispatchSlot {
  turnDispatchOwner: string | undefined;
}

/**
 * Take the slot for `token`. Returns `true` when it was free and is now ours,
 * `false` when someone else holds it — in which case the caller MUST NOT
 * dispatch.
 */
export const claimDispatchSlot = (slot: DispatchSlot, token: string): boolean => {
  if (slot.turnDispatchOwner !== undefined) return false;
  slot.turnDispatchOwner = token;
  return true;
};

/** Is the slot held by anyone? */
export const isDispatchSlotHeld = (slot: DispatchSlot): boolean =>
  slot.turnDispatchOwner !== undefined;

/**
 * Release the slot, but ONLY if `token` still owns it.
 *
 * The owner check is what stops a turn releasing a claim it never took. Without
 * it a non-claimant reaching its own `finalize` would free the real claimant's
 * slot, re-opening the window the claim exists to close. Returns whether a
 * release actually happened.
 */
export const releaseDispatchSlot = (slot: DispatchSlot, token: string): boolean => {
  if (slot.turnDispatchOwner !== token) return false;
  slot.turnDispatchOwner = undefined;
  return true;
};
