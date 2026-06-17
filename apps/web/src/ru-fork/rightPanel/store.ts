/**
 * ru-fork: coordinator for the global right-side overlay panels (the registry in
 * ./registry). A single `open` enum makes them mutually exclusive for free, and
 * `toggle()` gives click-again-to-close.
 *
 * The diff panel stays URL-driven and thread-scoped (NOT modelled here); it
 * coordinates with this store at two thin seams in the thread route:
 *   - opening diff calls `close()` (closes whichever overlay is open);
 *   - an effect closes diff whenever an overlay opens.
 */

import { create } from "zustand";
import type { OverlayPanel } from "./registry";

interface RightPanelState {
  readonly open: OverlayPanel | null;
  readonly toggle: (panel: OverlayPanel) => void;
  readonly close: () => void;
}

export const useRightPanelStore = create<RightPanelState>()((set) => ({
  open: null,
  toggle: (panel) => set((state) => ({ open: state.open === panel ? null : panel })),
  close: () => set({ open: null }),
}));
