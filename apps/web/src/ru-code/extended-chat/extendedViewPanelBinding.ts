// ru-code: THE BINDING between the extended view's per-thread detail target and the global
// right-panel store (sync-wave R3). Two stores, one truth:
//   * the PACKAGE owns «what this thread is inspecting» (`extendedChatUiStore.inspector`,
//     written by the five openers inside the thread);
//   * the APP owns «which global panel has the right slot» (`useRightGlobalPanelStore`).
// This module is the only thing that keeps them consistent, and the decision is a PURE
// function so every one of R3's four cases is unit-testable without a DOM or a store.
import { useEffect, useRef } from "react";

import { clearExtendedViewPanelTarget, useExtendedViewPanelTarget } from "./extendedChatHost";
import { useRightGlobalPanelStore, type GlobalPanelId } from "../skills-agents/rightGlobalPanel";

export const EXTENDED_VIEW_PANEL_ID = "extended-view" satisfies GlobalPanelId;

export type ExtendedViewPanelBindingAction =
  /** R3 a/b — a target on the ACTIVE thread owns the slot: open, or REPLACE whatever holds it. */
  | "open-panel"
  /** R3 d — no target on the active thread (switched away, or left the extended view). */
  | "close-panel"
  /** R3 c — the slot stopped being ours: ✕, the sheet backdrop, or another panel took it. */
  | "clear-target"
  | null;

/**
 * The whole of R3, as one decision.
 *
 * `wasOpen` is what the global store held the last time this ran — the only way to tell «the
 * panel was taken from us» (clear the target) from «we have a target and no panel yet» (open
 * it). Without it the two cases are indistinguishable and fight each other: the effect would
 * reopen the panel the ✕ just closed.
 *
 * A target REPLACED while the panel is open answers `null` on purpose: the panel instance
 * stays, and its content follows the publication (R3b — no close/open flash).
 */
export function decideExtendedViewPanelBinding(input: {
  readonly hasTarget: boolean;
  readonly open: GlobalPanelId | null;
  readonly wasOpen: GlobalPanelId | null;
}): ExtendedViewPanelBindingAction {
  if (input.wasOpen === EXTENDED_VIEW_PANEL_ID && input.open !== EXTENDED_VIEW_PANEL_ID) {
    return "clear-target";
  }
  if (input.hasTarget && input.open !== EXTENDED_VIEW_PANEL_ID) {
    return "open-panel";
  }
  if (!input.hasTarget && input.open === EXTENDED_VIEW_PANEL_ID) {
    return "close-panel";
  }
  return null;
}

/**
 * Installed once, by the panel host (which is mounted above the routes and outlives every
 * thread). `toggle` is the family's own open/replace: it is only ever called when some OTHER
 * panel — or none — holds the slot, so it can never close ours.
 */
export function useExtendedViewPanelBinding(): void {
  const target = useExtendedViewPanelTarget();
  const open = useRightGlobalPanelStore((state) => state.open);
  const wasOpenRef = useRef<GlobalPanelId | null>(open);

  useEffect(() => {
    const action = decideExtendedViewPanelBinding({
      hasTarget: target !== null,
      open,
      wasOpen: wasOpenRef.current,
    });
    wasOpenRef.current = open;
    const store = useRightGlobalPanelStore.getState();
    if (action === "open-panel") {
      store.toggle(EXTENDED_VIEW_PANEL_ID);
    } else if (action === "close-panel") {
      store.close();
    } else if (action === "clear-target") {
      clearExtendedViewPanelTarget();
    }
  }, [target, open]);
}
