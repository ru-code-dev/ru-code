// ru-code (mid-turn wave, P3c): what a delivery state LOOKS like on a balloon.
//
// Kept as a pure descriptor rather than JSX so the rule is testable without
// rendering, and so the port's message renderer needs only a one-line call
// instead of carrying our branching. Same shape as the fork's existing
// `workLog/workToneVisuals.ts`, for the same reason.
//
// The owner's UX (wave-midturn-plan.md) is deliberately minimal: three icon
// states on an ORDINARY message balloon. No queue-block UI, no per-message ✕,
// no unschedule, no balloon movement.
import type { MidTurnDeliveryState } from "@t3tools/contracts";

export interface MidTurnDeliveryMark {
  /** Lucide-style icon name the balloon footer renders. */
  readonly icon: "clock" | "alert-circle";
  /** Tailwind text colour token for the icon. */
  readonly className: string;
  /**
   * Accessible label — the ONLY place this state is described in words.
   *
   * ru-code: an ENGLISH literal on purpose. This repo keeps source strings in
   * English and the localization build rewrites them into `L(en, ru)` pairs
   * (same as AgentsPanel's status labels). Hardcoding Russian here would ship
   * an unlocalizable string that renders Russian even in an English build.
   */
  readonly label: string;
}

/**
 * The mark for a delivery state, or `null` for "render nothing".
 *
 * `delivered` and `undefined` BOTH render nothing, and that is the whole design:
 * a delivered mid-turn message is just a message, and an ordinary message never
 * had a mark to begin with. Adding a tick for `delivered` would put a novel
 * marker on the overwhelmingly common case — every message in every thread —
 * to communicate the absence of a problem.
 */
export function midTurnDeliveryMark(
  state: MidTurnDeliveryState | undefined,
): MidTurnDeliveryMark | null {
  switch (state) {
    case "pending":
      return {
        icon: "clock",
        className: "text-muted-foreground",
        label: "Waiting to send",
      };
    case "not-delivered":
      return {
        icon: "alert-circle",
        className: "text-destructive",
        label: "Not sent",
      };
    case "delivered":
    case undefined:
      return null;
  }
}
