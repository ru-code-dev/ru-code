// ru-code v2: the isolation MECHANISM.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. `apps/web`'s unit project runs in the NODE environment —
// there is no jsdom or happy-dom in this repo, and adding one would be a new app dependency — and
// React error boundaries do not participate in server rendering: a component that throws re-throws
// out of `renderToStaticMarkup`. So what is pinned here is the mechanism, in the halves that are
// testable without a DOM:
//
//   1. the host mounts an ELEMENT, never a call — `PluginSurface` does not evaluate the plugin's
//      component, which is the whole reason a synchronous throw cannot escape the boundary;
//   2. the slot boundary's state machine — it empties, it reports, it calls back, and it recovers
//      when the slot is given something else;
//   3. the attribution rule the router root reads, and the once-per-plugin-per-surface report;
//   4. the icon-by-name resolution, which is what keeps plugin React out of host menus entirely.
//
// The RENDERED result — a fallback card, the app still interactive, one toast — is pinned in a real
// browser by `ru-code/e2e/tests-plugins/renderFaults.e2e.test.ts`.
import { createElement, isValidElement, type ComponentType } from "react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { PluginIcon, pluginIconComponent, resolvePluginIcon } from "../../plugins/PluginIcon";
import {
  PluginSlotBoundary,
  PluginSurface,
  pluginCrashCandidate,
  recoverFromPluginCrash,
  reportPluginRenderFault,
  resetPluginRenderFaults,
} from "../../plugins/PluginSurface";
import { resetPluginProblems } from "../../plugins/problems";
// V2-42: a host finding about a plugin is a status row and a console line, never a toast — so this
// is where every assertion below reads it from.
import { getPluginProblems as getPendingPluginProblems } from "../../plugins/status";
import { recordPluginDisplayName, resetPluginDisplayNames } from "../../plugins/status";

beforeEach(() => {
  resetPluginRenderFaults();
  resetPluginProblems();
  resetPluginDisplayNames();
  recordPluginDisplayName("demo", "Demo");
});

describe("PluginSurface", () => {
  it("returns an element and does NOT evaluate the plugin's component", () => {
    // `<Boundary>{render()}</Boundary>` evaluates the component OUTSIDE the boundary, so a
    // synchronous throw escapes it — the exact fixture that blanked the app in v1. The host mounts
    // `createElement(render)` instead, and this is that difference, measured: building the surface
    // must not call the plugin at all.
    let called = 0;
    const Counted: ComponentType = () => {
      called += 1;
      return null;
    };
    const element = PluginSurface({ pluginId: "demo", render: Counted, surface: "page" });
    expect(isValidElement(element)).toBe(true);
    expect(called).toBe(0);
  });
});

describe("PluginSlotBoundary", () => {
  it("empties the slot, names the plugin and calls back when a child escapes", () => {
    let closed = 0;
    const boundary = new PluginSlotBoundary({
      pluginId: "demo",
      onFault: () => {
        closed += 1;
      },
      children: null,
    });
    expect(PluginSlotBoundary.getDerivedStateFromError(new Error("x"))).toEqual({
      failed: true,
      error: expect.anything(),
    });
    boundary.componentDidCatch(new Error("slot exploded"));
    expect(closed).toBe(1);
    const problems = getPendingPluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("render:slot");
    expect(problems[0]?.title).toContain("Demo");
  });

  it("blames nobody when the slot held a BUILT-IN surface", () => {
    let closed = 0;
    const boundary = new PluginSlotBoundary({
      pluginId: null,
      onFault: () => {
        closed += 1;
      },
      children: null,
    });
    boundary.componentDidCatch(new Error("app exploded"));
    // Still closes the slot — the surface in it is gone either way — but attributes nothing.
    expect(closed).toBe(1);
    expect(getPendingPluginProblems()).toEqual([]);
    expect(pluginCrashCandidate()).toBeNull();
  });

  it("renders its children until it catches, and nothing afterwards", () => {
    const boundary = new PluginSlotBoundary({ pluginId: "demo", children: "content" });
    expect(boundary.render()).toBe("content");
    boundary.state = { failed: true, error: new Error("x") };
    expect(boundary.render()).toBeNull();
  });
});

describe("fault attribution", () => {
  it("reports a fault ONCE per plugin and surface", () => {
    reportPluginRenderFault({ pluginId: "demo", surface: "panel", error: new Error("a") });
    reportPluginRenderFault({ pluginId: "demo", surface: "panel", error: new Error("b") });
    expect(getPendingPluginProblems()).toHaveLength(1);
  });

  it("reports the same plugin again for a DIFFERENT surface", () => {
    reportPluginRenderFault({ pluginId: "demo", surface: "panel", error: new Error("a") });
    reportPluginRenderFault({ pluginId: "demo", surface: "page", error: new Error("b") });
    expect(getPendingPluginProblems()).toHaveLength(2);
  });

  it("keeps only the first line of a multi-line error out of the message", () => {
    reportPluginRenderFault({
      pluginId: "demo",
      surface: "page",
      error: new Error("boom\n    at Component (/home/user/plugins/demo/web/index.mjs:1:1)"),
    });
    expect(getPendingPluginProblems()[0]?.detail).toBe("page: boom");
  });

  it("blames nobody when no plugin boundary has caught", () => {
    expect(pluginCrashCandidate()).toBeNull();
  });

  it("blames the plugin whose boundary caught a moment ago, exactly once", () => {
    const boundary = new PluginSlotBoundary({ pluginId: "demo", children: null });
    boundary.componentDidCatch(new Error("boom"));
    expect(pluginCrashCandidate()).toBe("demo");
    recoverFromPluginCrash("demo", new Error("boom"));
    // A SECOND crash from the same plugin is an app that is genuinely broken: show the card.
    expect(pluginCrashCandidate()).toBeNull();
    const again = new PluginSlotBoundary({ pluginId: "demo", children: null });
    again.componentDidCatch(new Error("boom"));
    expect(pluginCrashCandidate()).toBeNull();
  });
});

describe("PluginIcon", () => {
  it("resolves a lucide icon by PascalCase and by kebab-case", () => {
    expect(resolvePluginIcon("Puzzle")).not.toBeNull();
    expect(resolvePluginIcon("chart-bar")).toBe(resolvePluginIcon("ChartBar"));
  });

  it("answers null for a name this build does not know, and for no name", () => {
    expect(resolvePluginIcon("NoSuchIconAnywhere")).toBeNull();
    expect(resolvePluginIcon(undefined)).toBeNull();
    expect(resolvePluginIcon("")).toBeNull();
  });

  it("renders an element for an unknown name instead of throwing or leaving a hole", () => {
    expect(isValidElement(PluginIcon({ name: "NoSuchIconAnywhere" }))).toBe(true);
    expect(isValidElement(PluginIcon({}))).toBe(true);
  });

  it("closes the NAME over a component, so nothing plugin-authored is mounted", () => {
    const Icon = pluginIconComponent("Puzzle");
    expect(typeof Icon).toBe("function");
    expect(isValidElement(createElement(Icon, { className: "size-4" }))).toBe(true);
  });
});
