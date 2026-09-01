// ru-code (sync wave R1/R2/R3): the extended view's detail panel as a member of the GLOBAL
// right-panel family.
//   R1 — it is in the family's enum and its registry, so the slot invariant and the N-way
//        mutual exclusion apply to it for free;
//   R2 — it has NO nav entry: `NAV_PANELS` is what every nav renders;
//   R3 — the binding between the thread's target and the global store, all four cases.
import { describe, expect, it } from "vite-plus/test";

import {
  decideExtendedViewPanelBinding,
  EXTENDED_VIEW_PANEL_ID,
} from "../../../extended-chat/extendedViewPanelBinding";
import {
  NAV_PANELS,
  OVERLAY_PANELS,
  overlayPanelById,
} from "../../../skills-agents/rightGlobalPanel/registry";
import { useRightGlobalPanelStore } from "../../../skills-agents/rightGlobalPanel/store";

describe("R1 — the panel is a full member of the family", () => {
  it("is registered, and the family's own toggle gives it open/replace/close for free", () => {
    expect(overlayPanelById(EXTENDED_VIEW_PANEL_ID)).not.toBeNull();
    const store = useRightGlobalPanelStore.getState();
    store.close();
    store.toggle("mcp");
    expect(useRightGlobalPanelStore.getState().open).toBe("mcp");
    // REPLACE: opening ours takes the slot from MCP — no bespoke exclusion needed.
    useRightGlobalPanelStore.getState().toggle(EXTENDED_VIEW_PANEL_ID);
    expect(useRightGlobalPanelStore.getState().open).toBe(EXTENDED_VIEW_PANEL_ID);
    // …and another panel takes it straight back.
    useRightGlobalPanelStore.getState().toggle("skills");
    expect(useRightGlobalPanelStore.getState().open).toBe("skills");
    useRightGlobalPanelStore.getState().close();
  });
});

describe("R2 — no rail icon", () => {
  it("NAV_PANELS is the registry minus the navHidden entries, and ours is the hidden one", () => {
    expect(OVERLAY_PANELS.map((panel) => panel.id)).toContain(EXTENDED_VIEW_PANEL_ID);
    expect(NAV_PANELS.map((panel) => panel.id)).not.toContain(EXTENDED_VIEW_PANEL_ID);
    // Every OTHER panel still has its nav entry — this must not quietly hide anything else.
    expect(NAV_PANELS.map((panel) => panel.id)).toEqual([
      "skills",
      "agents",
      "commands",
      "mcp",
      "pixso",
    ]);
    expect(overlayPanelById(EXTENDED_VIEW_PANEL_ID)?.navHidden).toBe(true);
  });
});

describe("R3 — the binding, case by case", () => {
  const decide = (
    hasTarget: boolean,
    open: "extended-view" | "mcp" | null,
    wasOpen: "extended-view" | "mcp" | null,
  ) => decideExtendedViewPanelBinding({ hasTarget, open, wasOpen });

  it("(a) a target with the slot free — or held by another panel — OPENS/REPLACES", () => {
    expect(decide(true, null, null)).toBe("open-panel");
    expect(decide(true, "mcp", "mcp")).toBe("open-panel");
  });

  it("(b) a target REPLACED while the panel is open does nothing — the instance stays", () => {
    // The content follows the publication, so there is no close/open flash to produce.
    expect(decide(true, "extended-view", "extended-view")).toBeNull();
  });

  it("(c) the slot stopped being ours (✕ / backdrop / another panel) CLEARS the target", () => {
    expect(decide(true, null, "extended-view")).toBe("clear-target");
    expect(decide(true, "mcp", "extended-view")).toBe("clear-target");
    // …and it wins over the open case, or the two would fight: the ✕ would reopen the panel.
    expect(decide(true, null, "extended-view")).not.toBe("open-panel");
  });

  it("(d) no target while the panel is open CLOSES it — a thread switch, or leaving the view", () => {
    expect(decide(false, "extended-view", "extended-view")).toBe("close-panel");
  });

  it("does nothing at rest, or while another panel owns the slot with nothing to show", () => {
    expect(decide(false, null, null)).toBeNull();
    expect(decide(false, "mcp", "mcp")).toBeNull();
    expect(decide(false, "mcp", null)).toBeNull();
  });
});
