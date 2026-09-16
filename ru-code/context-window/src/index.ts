// ru-code (qwen-compression wave): THE RETENTION RULE for `context-window.updated`
// activity rows — one source, read by the two places that prune them.
//
// Both consumers only ever want the LATEST usage value, so the rows are pruned
// rather than accumulated (a provider streams one per model round; a long thread
// otherwise grows by thousands). Retention is per TURN, because a live
// `thread.reverted` makes the client discard whole turns and the meter must
// still resolve a value from the turns that survive.
//
// WHY THIS MODULE EXISTS — the compaction row. A HIDDEN compaction runs with no
// turn of ours at all (`compactContext` refuses to start during one), so its
// usage row lands with `turnId: null` and formed its own retention bucket: it
// coexisted with the previous turn's rows instead of replacing them, and won the
// consumer's backward walk only because it happened to sort last. A row with no
// turn is a statement about the WHOLE thread — the context was just rewritten —
// so it must supersede every earlier row, whatever turn they belonged to.
//
// The two pruners are upstream files (`packages/client-runtime/.../threadReducer.ts`
// and `apps/server/src/orchestration/ActivityPayloadProjection.ts`); each keeps
// its own "is this row resolvable" predicate and delegates the KEY decision
// here, so they cannot drift apart.

/**
 * Does a newer resolvable context-window row supersede an earlier one?
 *
 * `null` on the newer row means "no turn owned this change" — a compaction
 * rewrote the thread's context — so it replaces every earlier row. Otherwise
 * retention stays per turn.
 */
export function contextWindowSupersedes(
  newerTurnId: string | null,
  earlierTurnId: string | null,
): boolean {
  return newerTurnId === null || newerTurnId === earlierTurnId;
}

/**
 * Keep only the context-window rows that are still current, in place, for a
 * snapshot that is walked front-to-back.
 *
 * `items` must be in timeline order. `isResolvable` marks the rows this rule
 * governs — a malformed row is passed through untouched rather than shadowing a
 * valid earlier one — and `turnIdOf` reads the row's turn. Rows the rule does
 * not govern are never dropped.
 *
 * Applies {@link contextWindowSupersedes} pairwise: the last row of each turn
 * survives, and a `turnId: null` row drops every resolvable row before it.
 */
export function retainCurrentContextWindowRows<A>(
  items: ReadonlyArray<A>,
  isResolvable: (item: A) => boolean,
  turnIdOf: (item: A) => string | null,
): ReadonlyArray<A> {
  const drop = new Set<number>();
  const keptTurnIds = new Set<string | null>();
  // Backwards: the first resolvable row seen for a turn is that turn's latest,
  // and once a `null`-turn row is kept nothing resolvable before it survives.
  let supersededByNullTurn = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (!isResolvable(item)) continue;
    if (supersededByNullTurn) {
      drop.add(index);
      continue;
    }
    const turnId = turnIdOf(item);
    if (keptTurnIds.has(turnId)) {
      drop.add(index);
      continue;
    }
    keptTurnIds.add(turnId);
    if (turnId === null) supersededByNullTurn = true;
  }
  if (drop.size === 0) return items;
  return items.filter((_item, index) => !drop.has(index));
}
