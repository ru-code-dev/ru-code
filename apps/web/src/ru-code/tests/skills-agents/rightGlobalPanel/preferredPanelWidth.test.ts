// ru-code (A16, SDK 0.2.0): `registerPanel({ preferredWidth })` — the host's half.
//
// The width itself is one number, but it arrives from a PLUGIN and lands in a `style` attribute,
// so the two things worth pinning are the ones that are silent when they go wrong:
//
//   1. a non-finite value must not reach the width hook. `useResizableWidth`'s own `clamp` returns
//      `defaultWidth` for a non-finite input, so a `NaN` default clamps to `NaN`, renders
//      `width: NaNpx`, and the browser DROPS the declaration — the docked column collapses to its
//      flex minimum with nothing in the console.
//   2. the clamp is 320–960 and not the panel family's own 320–640 drag range. Raising the shared
//      ceiling was the alternative (phase-2 plan §2.7 / owner decision O3) and it would have
//      re-sized every panel in the app; `preferredWidth` deliberately does not.
//
// What is NOT tested here, because it is not this function's: "the persisted user width still
// wins". That is `useResizableWidth`'s state initializer, which prefers the stored value over
// `defaultWidth` and is covered by the hook's own contract — the host only ever hands it a
// DEFAULT.

import { describe, expect, it } from "vite-plus/test";

import { preferredPanelWidth } from "~/ru-code/skills-agents/rightGlobalPanel/RightGlobalPanelHost";
import type { OverlayPanel } from "~/ru-code/skills-agents/rightGlobalPanel/registry";
import { makeGlobalPanelId } from "~/ru-code/skills-agents/rightGlobalPanel/store";

const panelId = makeGlobalPanelId("plugin:analytics");
if (panelId === null) throw new Error("the test id is not a valid GlobalPanelId");

const panel = (preferredWidth?: unknown): OverlayPanel =>
  ({
    id: panelId,
    label: "Analytics",
    icon: () => null,
    render: () => null,
    ...(preferredWidth === undefined ? {} : { preferredWidth }),
  }) as unknown as OverlayPanel;

describe("preferredPanelWidth", () => {
  it("is null when the panel asked for nothing", () => {
    expect(preferredPanelWidth(panel())).toBeNull();
    // No panel open at all — the host calls it with the active panel, which may be null.
    expect(preferredPanelWidth(null)).toBeNull();
  });

  it("passes a width inside the range through unchanged", () => {
    expect(preferredPanelWidth(panel(320))).toBe(320);
    expect(preferredPanelWidth(panel(720))).toBe(720);
    expect(preferredPanelWidth(panel(960))).toBe(960);
  });

  it("clamps to 320–960 — wider than the shared 640 drag ceiling, on purpose", () => {
    expect(preferredPanelWidth(panel(10))).toBe(320);
    expect(preferredPanelWidth(panel(-1))).toBe(320);
    expect(preferredPanelWidth(panel(4000))).toBe(960);
    // The point of the separate ceiling: 900 survives, where a clamp against PANEL_MAX_WIDTH
    // would have quietly returned 640 and the six-column board would never fit.
    expect(preferredPanelWidth(panel(900))).toBe(900);
  });

  it("refuses a non-finite or non-numeric width instead of rendering NaNpx", () => {
    expect(preferredPanelWidth(panel(Number.NaN))).toBeNull();
    expect(preferredPanelWidth(panel(Number.POSITIVE_INFINITY))).toBeNull();
    expect(preferredPanelWidth(panel(Number.NEGATIVE_INFINITY))).toBeNull();
    // Types are erased at the plugin boundary: these really can arrive.
    expect(preferredPanelWidth(panel("600"))).toBeNull();
    expect(preferredPanelWidth(panel(null))).toBeNull();
    expect(preferredPanelWidth(panel({ valueOf: () => 600 }))).toBeNull();
  });
});
