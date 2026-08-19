// ru-code: the "Переключить правую панель" button decision, extracted so the WHOLE composite is
// testable (the bug that shipped lived in the composite, not in any single fragment). Given the panel
// state, it returns the ordered actions the button should perform. The React callback in ChatView just
// applies them — mirroring the dispatch.ts pattern (pure decision → applied capabilities).

export type RightPanelToggleAction = "close-global" | "close-preview" | "open-thread";

export interface RightPanelToggleState {
  /** A global panel (skills/agents) currently owns the right slot. */
  readonly globalPanelOpen: boolean;
  /** There is an active thread whose panel could be shown. */
  readonly hasActiveThread: boolean;
  /** The thread panel's own open state (may be hidden behind the global panel). */
  readonly threadPanelOpen: boolean;
}

export const decideRightPanelToggle = (
  state: RightPanelToggleState,
): ReadonlyArray<RightPanelToggleAction> => {
  if (state.globalPanelOpen) {
    // Release the global panel. If the thread panel had content it is revealed by the render gate; if
    // it was empty, ALSO open it so a single press switches to the thread panel (not two).
    if (!state.threadPanelOpen && state.hasActiveThread) {
      return ["close-global", "open-thread"];
    }
    return ["close-global"];
  }
  if (!state.hasActiveThread) {
    return [];
  }
  if (state.threadPanelOpen) {
    return ["close-preview"];
  }
  return ["open-thread"];
};
