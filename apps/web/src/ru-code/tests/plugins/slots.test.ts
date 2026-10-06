// ru-code v2 (V2-15): `ctx.closePanel(id)`, the plugins folder's side of the app's overlay store.
//
// The claim is narrow and worth pinning exactly, because the seam hands a plugin a WRITE into app
// state and every other member of `ctx` is a read: a plugin may close ONE panel — its own — and
// only while that panel is the one the user has open. Everything else is a no-op, including the
// case that matters most, another plugin's panel being open.
//
// Pure store assertions in the node tier: what a click on the wrapped panel's X does with it is the
// e2e's job (`panel.e2e.test.ts`), and the store is the whole of the host's half.
//
// THE GLOBAL SLOT'S ARM ONLY (V2-27). `closePluginPanel` tries the THREAD TAB first and falls
// through to the store below, so a panel mounted with `mount: "tab"` is closed by the other arm —
// covered, with the same "only your own" rules, in `tests/plugins/tabSurfaces.test.ts`.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  pluginPanelId,
  useRightGlobalPanelStore,
} from "../../skills-agents/rightGlobalPanel/store";

import { closePluginPanel } from "../../plugins/slots";

const open = (panel: string): void => {
  const id = pluginPanelId("demo", panel);
  if (id === null) throw new Error(`not a legal panel id: ${panel}`);
  useRightGlobalPanelStore.setState({ open: id });
};
const openPanel = (): string | null => useRightGlobalPanelStore.getState().open;

describe("closePluginPanel", () => {
  beforeEach(() => {
    useRightGlobalPanelStore.setState({ open: null });
  });

  it("closes the plugin's OWN panel when that panel is the open one", () => {
    open("side");
    closePluginPanel("demo", "side");
    expect(openPanel()).toBe(null);
  });

  it("does nothing when a DIFFERENT panel of the same plugin is open", () => {
    open("side");
    closePluginPanel("demo", "other");
    expect(openPanel()).toBe("plugin:demo:side");
  });

  it("cannot close ANOTHER plugin's panel", () => {
    // The id is composed from the CALLER's plugin id, so `catalogs` naming the demo's panel
    // produces `plugin:catalogs:side` — an id that is not open and never will be.
    open("side");
    closePluginPanel("catalogs", "side");
    expect(openPanel()).toBe("plugin:demo:side");
  });

  // S111 #1: ONE rule for a panel id. The seam keeps `2fa` (`PLUGIN_SLUG_PATTERN` admits a leading
  // digit, S110 R03); the global slot's own second pattern did not, so the panel was dropped from
  // the slot with no report (R04). The slot now composes the id from the same two rules the seam
  // and the manifest apply, so it cannot refuse what they accepted.
  it("S111 #1: a panel id that starts with a digit is a legal global panel, and its owner can close it", () => {
    expect(pluginPanelId("demo", "2fa")).toBe("plugin:demo:2fa");
    open("2fa");
    closePluginPanel("demo", "2fa");
    expect(openPanel()).toBe(null);
  });

  it("S111 #1: the slot still refuses what the seam refuses", () => {
    for (const bad of ["Notes", "-x", "a/b", "a:b", "x".repeat(65)]) {
      expect(pluginPanelId("demo", bad)).toBe(null);
    }
  });

  it("cannot close a BUILT-IN panel", () => {
    useRightGlobalPanelStore.setState({ open: "mcp" });
    closePluginPanel("demo", "mcp");
    expect(openPanel()).toBe("mcp");
  });

  it("is a no-op when nothing is open, and when the id is not a legal slug", () => {
    closePluginPanel("demo", "side");
    expect(openPanel()).toBe(null);
    open("side");
    closePluginPanel("demo", "NOT A SLUG");
    expect(openPanel()).toBe("plugin:demo:side");
  });
});
