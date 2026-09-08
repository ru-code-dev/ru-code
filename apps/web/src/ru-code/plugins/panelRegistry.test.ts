// ru-code: the panel registry once it is OPEN (mvp-plan §1.4, risk 4).
//
// The seam a dropped-in plugin depends on: register a panel at boot, and every nav and the
// panel host find it exactly as if it had been in the seed array — while the built-in panels
// keep their literal ids and their order. `GlobalPanelId` is validated, never trusted, so a
// malformed id from a plugin manifest is refused instead of reaching the registry.

import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  navPanels,
  overlayPanelById,
  overlayPanels,
  registerOverlayPanel,
  resetRegisteredOverlayPanels,
  OVERLAY_PANELS,
} from "../skills-agents/rightGlobalPanel/registry";
import { makeGlobalPanelId, pluginPanelId } from "../skills-agents/rightGlobalPanel/store";

const SEED_IDS = OVERLAY_PANELS.map((panel) => panel.id);
const Icon = () => null;

const panel = (id: string, extra: { navHidden?: boolean; label?: string } = {}) => {
  const panelId = makeGlobalPanelId(id);
  if (panelId === null) throw new Error(`bad test id ${id}`);
  return {
    id: panelId,
    label: extra.label ?? id,
    icon: Icon,
    ...(extra.navHidden === undefined ? {} : { navHidden: extra.navHidden }),
    render: () => null,
  };
};

beforeEach(() => {
  resetRegisteredOverlayPanels();
});

describe("makeGlobalPanelId", () => {
  it("accepts a lowercase slug and the `:`-segmented plugin form", () => {
    expect(makeGlobalPanelId("mcp")).toBe("mcp");
    expect(makeGlobalPanelId("plugin:demo")).toBe("plugin:demo");
    expect(makeGlobalPanelId("plugin:demo:notes-2")).toBe("plugin:demo:notes-2");
  });

  it.each([
    ["", "empty"],
    ["Skills", "uppercase"],
    ["2fast", "leading digit"],
    ["-lead", "leading dash"],
    ["a/b", "slash"],
    ["a..b", "dots"],
    ["plugin:", "empty trailing segment"],
    ["plugin::x", "empty middle segment"],
    ["a b", "space"],
    ["plugin:demo\u0000", "NUL"],
    ["plugin:demo\n", "newline"],
  ])("rejects %j (%s)", (value) => {
    expect(makeGlobalPanelId(value)).toBeNull();
  });
});

describe("pluginPanelId", () => {
  it("is `plugin:<pluginId>` for a plugin's only panel and `:<panelId>` for the rest", () => {
    expect(pluginPanelId("demo")).toBe("plugin:demo");
    expect(pluginPanelId("demo", "")).toBe("plugin:demo");
    expect(pluginPanelId("demo", "notes")).toBe("plugin:demo:notes");
  });

  it("cannot collide with a built-in id, whatever a manifest says", () => {
    for (const id of SEED_IDS) {
      expect(pluginPanelId(id)).not.toBe(id);
    }
    expect(pluginPanelId("demo", "Bad Id")).toBeNull();
  });
});

describe("registerOverlayPanel", () => {
  it("appears in overlayPanels() and navPanels(), after the seed", () => {
    registerOverlayPanel(panel("plugin:demo", { label: "Demo" }));
    expect(overlayPanels().map((entry) => entry.id)).toEqual([...SEED_IDS, "plugin:demo"]);
    expect(navPanels().map((entry) => entry.id)).toContain("plugin:demo");
  });

  it("honours navHidden — the panel exists but no nav offers it", () => {
    registerOverlayPanel(panel("plugin:demo:detail", { navHidden: true }));
    expect(overlayPanels().map((entry) => entry.id)).toContain("plugin:demo:detail");
    expect(navPanels().map((entry) => entry.id)).not.toContain("plugin:demo:detail");
  });

  it("replaces on a duplicate id rather than throwing or growing the list", () => {
    registerOverlayPanel(panel("plugin:demo", { label: "First" }));
    registerOverlayPanel(panel("plugin:demo", { label: "Second" }));
    const matches = overlayPanels().filter((entry) => entry.id === "plugin:demo");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe("Second");
  });

  it("never lets a plugin shadow a built-in panel", () => {
    registerOverlayPanel(panel("mcp", { label: "Hijacked" }));
    expect(overlayPanels().filter((entry) => entry.id === "mcp")).toHaveLength(1);
    expect(overlayPanelById("mcp")?.label).not.toBe("Hijacked");
  });

  it("leaves the seed untouched when nothing registered", () => {
    expect(overlayPanels()).toBe(OVERLAY_PANELS);
    expect(navPanels().map((entry) => entry.id)).toEqual(["mcp", "pixso"]);
  });
});

describe("overlayPanelById", () => {
  it("resolves both built-in and plugin ids, and null for an id this build never heard of", () => {
    const registered = registerOverlayPanel(panel("plugin:demo"));
    // A plugin id is only reachable through the brand — a bare string literal is (correctly)
    // rejected by the compiler, which is the whole point of the open branded slug.
    expect(overlayPanelById("pixso")?.id).toBe("pixso");
    expect(overlayPanelById(registered)?.id).toBe("plugin:demo");
    const unknown = makeGlobalPanelId("plugin:gone");
    if (unknown === null) throw new Error("unreachable");
    expect(overlayPanelById(unknown)).toBeNull();
  });
});
