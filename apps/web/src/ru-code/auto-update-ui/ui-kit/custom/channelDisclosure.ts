// ru-code: when a source card's configuration area is open — the whole rule, as one pure function.
//
// The rule the owner stated: the block is open when there is a REAL PROBLEM, or when the user
// opened it. A clean check must never touch it.
//
// Two things made the old inline version break that rule:
//
//   · `useState(attention)` made `open` a MOUNT SNAPSHOT. Every remount of the card re-derived it
//     from whatever `attention` happened to be at that instant, which is why pressing «Проверить»
//     with zero errors expanded the block and then collapsed it again on its own. (The auto-close is
//     the proof: nothing but the user ever closed it, so a card that closes itself was remounted.)
//     It also meant a card could not open at all when its source broke AFTER mount.
//
//   · `probing` REPLACES the health while a request is in flight, so attention computed from the
//     live health flickers off for the duration of every check — collapsing a card that is open
//     precisely because that source is broken.
//
// Keeping the decision here, pure, is what lets both be tested without a DOM.

import type { ChannelHealth } from "../../model";

/** The health values that mean "this source needs the user", once the request has settled. */
const ATTENTION_HEALTHS: ReadonlySet<ChannelHealth> = new Set<ChannelHealth>([
  "needs-setup",
  "unreachable",
]);

/**
 * The health a verdict was last seen at. `probing` carries no verdict — it is the request, not its
 * answer — so it leaves the previous one standing.
 */
export const settleHealth = (previous: ChannelHealth, incoming: ChannelHealth): ChannelHealth =>
  incoming === "probing" ? previous : incoming;

/** Does this source need the user's attention? Disabled sources never do. */
export const needsAttention = (input: {
  readonly enabled: boolean;
  readonly settledHealth: ChannelHealth;
}): boolean => input.enabled && ATTENTION_HEALTHS.has(input.settledHealth);

/**
 * Is the configuration area open? `userSet` is null until the user touches the disclosure; from
 * then on their choice wins for as long as the card lives — including over a problem appearing
 * (they closed it) and over a problem clearing (they opened it).
 */
export const isDisclosureOpen = (input: {
  readonly userSet: boolean | null;
  readonly attention: boolean;
}): boolean => input.userSet ?? input.attention;
