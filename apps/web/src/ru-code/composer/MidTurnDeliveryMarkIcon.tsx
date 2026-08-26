// ru-code (mid-turn wave, P3c): the balloon's delivery mark.
//
// Deliberately a self-contained component in the fork's zone so the port's
// message renderer carries ONE marked line instead of our branching, our icon
// choices and our labels. The rule itself lives in `midTurnDeliveryMark.ts` and
// is unit-tested without rendering.
import type { MidTurnDeliveryState } from "@t3tools/contracts";
import { AlertCircle, Clock } from "lucide-react";

import { midTurnDeliveryMark } from "./midTurnDeliveryMark";

/**
 * Renders nothing for `delivered` and for an ordinary message — see
 * {@link midTurnDeliveryMark} for why the delivered case is deliberately
 * unmarked.
 *
 * Note this sits OUTSIDE the hover-revealed timestamp footer: a pending clock
 * and a not-delivered warning must be visible without hovering, or they cannot
 * do their job.
 */
export function MidTurnDeliveryMarkIcon({ state }: { state: MidTurnDeliveryState | undefined }) {
  const mark = midTurnDeliveryMark(state);
  if (!mark) return null;
  const Icon = mark.icon === "clock" ? Clock : AlertCircle;
  return (
    <span
      className={`flex items-center gap-1 pe-1 text-xs ${mark.className}`}
      // ru-code (ap-final T4): an EXACT hook for the e2e spec. `role="status"` is
      // shared vocabulary — `ui/spinner.tsx:5-11` renders `role="status"` with
      // `aria-label="Loading"` — so a `[role="status"][aria-label]` locator also
      // matches every spinner on screen. That is what made
      // `midTurnDelivery.e2e.test.ts` flaky under full-suite load: `.first()`
      // resolved to a lingering spinner, the spec captured "Loading" as its
      // pending label, and the change-poll then mistook the real clock for the
      // post-stop state.
      data-testid="mid-turn-delivery-mark"
      role="status"
      // No native `title`: the repo forbids it as a tooltip
      // (t3code/no-native-title-tooltip). `aria-label` carries the accessible
      // name, and the mark is intentionally icon-only — a hover tooltip would
      // add a control affordance the owner's UX explicitly excludes.
      aria-label={mark.label}
    >
      <Icon className="size-3" aria-hidden="true" />
    </span>
  );
}
