// ru-code: the ONE pure decision behind the restart handover — "this tab lost the
// server in the middle of an update, so reload into the service-worker page".
//
// It exists because the previous rule was `state === null ⇒ the server died`, and
// `state === null` is ALSO the normal condition of every fresh page load (the atom
// is null until the WS subscription delivers its first snapshot). Boot → null →
// fresh marker still in Cache Storage → reload → boot → null → reload… — the
// infinite app ↔ SW-page blink. The fix is not a wider stale window: it is to
// trigger on a real DROP (a tab that HAD a snapshot and lost it), and to clear the
// marker the moment a live server proves the update is over.
//
// Two mechanisms exist and must never overlap: the SW's `decideNavigateFallback`
// (sw-kit/runtime.ts) answers a navigation that FAILED; this one runs only in a
// live tab. Pure data in, one verb out — the whole handover matrix is table-tested
// against it (tests/auto-update/handoverDecision.test.ts).

import { UPDATE_MARKER_STALE_MS } from "../sw-kit/runtime";

/**
 * A marker whose `startedAt` is further in the future than this came from a clock we
 * cannot trust — treated exactly as the SW treats it (see `decideNavigateFallback`).
 */
export const MARKER_FUTURE_TOLERANCE_MS = 60_000;

export interface HandoverInput {
  /** This tab has received at least one snapshot since it loaded. */
  readonly hadSnapshot: boolean;
  /** A snapshot is present right now (the environment is connected). */
  readonly connected: boolean;
  /** A server-owned run is live (not terminally failed) — the marker must stay. */
  readonly runActive: boolean;
  /** The persisted update marker, read from Cache Storage. */
  readonly marker: { readonly startedAt: number } | null;
  readonly now: number;
  /** `startedAt` of the marker this tab has ALREADY handed over for (session-scoped latch). */
  readonly handedOverFor: number | null;
  /**
   * The IN-APP restart wait is armed for this tab — i.e. the snapshot it is holding shows a run in
   * its `restart` phase, so the /healthz poll (restartWait.ts) is already running and owns the
   * outcome.
   *
   * Without this the two mechanisms raced and this one always won: a dropped connection under a
   * fresh marker reloaded the tab instantly, so `UPDATE_INAPP_WAIT_MS` never elapsed and a healthy
   * 3-second restart was escalated to the full-screen SW page as though the server had died. The
   * poll is strictly better informed — it asks /healthz, can return the tab IN PLACE on the new
   * version, and escalates itself once the budget is spent — so while it is armed, this decision
   * stands down.
   */
  readonly restartWaitArmed: boolean;
}

/**
 * `reload` — hand the screen to the service worker (the server is gone mid-update);
 * `clear` — the update is demonstrably over, drop the marker so no later boot reads it;
 * `wait` — do nothing.
 */
export type HandoverDecision = "reload" | "clear" | "wait";

export function decideHandover(input: HandoverInput): HandoverDecision {
  // A live server answers everything: mid-run the marker is load-bearing (the restart
  // is still ahead), otherwise the update is over and the marker is stale evidence —
  // including after a run that FAILED, which used to leave a fresh marker behind for
  // the whole stale window and turn the next F5 into a false «обновляется…» page.
  if (input.connected) {
    if (input.runActive) return "wait";
    return input.marker === null ? "wait" : "clear";
  }
  // Never on the initial connect: a tab that has never seen a snapshot is booting, not
  // dropping. This single condition is what ends the reload loop.
  if (!input.hadSnapshot) return "wait";
  if (input.marker === null) return "wait"; // an ordinary disconnect — the app handles it
  // The /healthz poll is on the case and can do better than a blind reload — let it spend its
  // budget. It escalates on its own once UPDATE_INAPP_WAIT_MS is up, so nothing is lost by waiting;
  // what IS lost by not waiting is every fast restart, which never gets to finish in place.
  if (input.restartWaitArmed) return "wait";
  const age = input.now - input.marker.startedAt;
  if (age < -MARKER_FUTURE_TOLERANCE_MS) return "wait";
  if (age > UPDATE_MARKER_STALE_MS) return "wait"; // a crashed update must not trap the tab
  // One marker moves a given tab at most once. Keyed by `startedAt` (not a boolean) so a
  // SECOND, genuinely new update can still hand the same tab over.
  if (input.handedOverFor === input.marker.startedAt) return "wait";
  return "reload";
}
