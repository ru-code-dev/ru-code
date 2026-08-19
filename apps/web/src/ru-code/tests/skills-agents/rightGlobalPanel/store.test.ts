import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  closeGlobalPanelIfOpen,
  isGlobalPanelOpen,
  useRightGlobalPanelStore,
} from "../../../skills-agents/rightGlobalPanel/store";

describe("rightGlobalPanel store", () => {
  beforeEach(() => {
    useRightGlobalPanelStore.setState({ open: null });
  });

  it("starts closed", () => {
    expect(useRightGlobalPanelStore.getState().open).toBeNull();
    expect(isGlobalPanelOpen()).toBe(false);
  });

  it("toggle opens a panel, and toggling the same one closes it", () => {
    const { toggle } = useRightGlobalPanelStore.getState();
    toggle("skills");
    expect(useRightGlobalPanelStore.getState().open).toBe("skills");
    expect(isGlobalPanelOpen()).toBe(true);
    toggle("skills");
    expect(useRightGlobalPanelStore.getState().open).toBeNull();
  });

  it("toggling a different panel switches (N-way mutual exclusion)", () => {
    const { toggle } = useRightGlobalPanelStore.getState();
    toggle("skills");
    toggle("agents");
    // Only one global panel is ever open.
    expect(useRightGlobalPanelStore.getState().open).toBe("agents");
  });

  it("close() hands the slot back to the thread panel", () => {
    const { toggle, close } = useRightGlobalPanelStore.getState();
    toggle("agents");
    close();
    expect(useRightGlobalPanelStore.getState().open).toBeNull();
    expect(isGlobalPanelOpen()).toBe(false);
  });

  describe("closeGlobalPanelIfOpen (right-panel toggle handoff)", () => {
    it("closes an open panel and reports it was open", () => {
      useRightGlobalPanelStore.getState().toggle("skills");
      expect(closeGlobalPanelIfOpen()).toBe(true);
      expect(useRightGlobalPanelStore.getState().open).toBeNull();
    });

    it("is a no-op when nothing is open (button falls through to the thread panel)", () => {
      expect(closeGlobalPanelIfOpen()).toBe(false);
      expect(useRightGlobalPanelStore.getState().open).toBeNull();
    });
  });
});
