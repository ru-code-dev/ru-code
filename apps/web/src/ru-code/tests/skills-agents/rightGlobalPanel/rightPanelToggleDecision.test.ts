import { describe, expect, it } from "vite-plus/test";

import {
  decideRightPanelToggle,
  type RightPanelToggleState,
} from "../../../skills-agents/rightGlobalPanel/rightPanelToggleDecision";

const state = (over: Partial<RightPanelToggleState>): RightPanelToggleState => ({
  globalPanelOpen: false,
  hasActiveThread: true,
  threadPanelOpen: false,
  ...over,
});

// TDD spec for the "Переключить правую панель" button — asserts the DESIRED behaviour for every
// branch. The `decideRightPanelToggle` currently mirrors the shipped code, so the empty-thread branch
// (skills open, no thread content) is expected to FAIL until the bug is fixed.
describe("decideRightPanelToggle", () => {
  describe("a global panel (skills/agents) owns the slot", () => {
    it("thread panel HAD content → just release global (the content is revealed by the gate)", () => {
      expect(
        decideRightPanelToggle(state({ globalPanelOpen: true, threadPanelOpen: true })),
      ).toEqual(["close-global"]);
    });

    it("thread panel EMPTY → release global AND open the thread panel in ONE press", () => {
      // ↑ THE BUG: one press should switch to the thread panel, not require a second click.
      expect(
        decideRightPanelToggle(
          state({ globalPanelOpen: true, threadPanelOpen: false, hasActiveThread: true }),
        ),
      ).toEqual(["close-global", "open-thread"]);
    });

    it("no active thread → just release global (nothing to open)", () => {
      expect(
        decideRightPanelToggle(
          state({ globalPanelOpen: true, threadPanelOpen: false, hasActiveThread: false }),
        ),
      ).toEqual(["close-global"]);
    });
  });

  describe("the thread panel owns the slot (no global panel)", () => {
    it("thread open → close preview", () => {
      expect(decideRightPanelToggle(state({ threadPanelOpen: true }))).toEqual(["close-preview"]);
    });

    it("thread closed with an active thread → open it", () => {
      expect(decideRightPanelToggle(state({ threadPanelOpen: false }))).toEqual(["open-thread"]);
    });

    it("no active thread → nothing", () => {
      expect(
        decideRightPanelToggle(state({ hasActiveThread: false, threadPanelOpen: false })),
      ).toEqual([]);
    });
  });
});
