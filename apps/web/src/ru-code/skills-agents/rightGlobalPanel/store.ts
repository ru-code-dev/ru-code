// ru-code: the global right-panel coordinator.
//
// Port's built-in right panel (rightPanelStore.ts) is THREAD-scoped — its surfaces
// (diff/files/preview/terminal/plan) belong to one thread. The skills/agents managers are
// GLOBAL (a skill is not owned by a thread), so they get their own coordinator that overlays
// the right slot and hides the thread panel while open (see ChatView's visibility gate). Only
// one global panel is open at a time (N-way mutual exclusion via the enum), mirroring the
// ru-code overlay coordinator this is ported from.

import { create } from "zustand";

/** The global overlay panels. Extend this union + the registry to add another. */
export type GlobalPanelId = "skills" | "agents" | "commands";

interface RightGlobalPanelState {
  /** The open global panel, or null when the thread panel owns the right slot. */
  readonly open: GlobalPanelId | null;
  /** Click-to-open, click-again-to-close (the sidebar nav buttons). */
  readonly toggle: (panel: GlobalPanelId) => void;
  /** Close the global panel (hand the right slot back to the thread panel). */
  readonly close: () => void;
}

export const useRightGlobalPanelStore = create<RightGlobalPanelState>((set) => ({
  open: null,
  toggle: (panel) => set((state) => ({ open: state.open === panel ? null : panel })),
  close: () => set({ open: null }),
}));

/** Non-reactive read for guards outside React (kept tiny so call sites stay obvious). */
export const isGlobalPanelOpen = (): boolean => useRightGlobalPanelStore.getState().open !== null;

/**
 * Close the global panel if one is open; returns whether it was. Lets the port's right-panel toggle
 * consume the click when the global panel owns the right slot (so the button closes IT, revealing the
 * thread panel again — non-destructive), instead of toggling the hidden thread panel underneath.
 */
export const closeGlobalPanelIfOpen = (): boolean => {
  if (useRightGlobalPanelStore.getState().open === null) return false;
  useRightGlobalPanelStore.getState().close();
  return true;
};
