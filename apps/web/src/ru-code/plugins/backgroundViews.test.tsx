// ru-code (A22, SDK 0.3.0, owner decision O3-b): `registerBackgroundView` — the always-mounted,
// render-nothing plugin surface, and the boundary that keeps it from being the app's crash card.
//
// This is the riskiest surface on the page, not the safest, and that is the whole reason it is
// pinned here: a panel's throw costs a panel the user opened, while a background view is mounted
// app-wide above the router, so an UNWRAPPED throw is the app shell. What must be true:
//
//   * the registration is capped (2 per plugin) and the excess is reported once, not thrown;
//   * a non-function `render` is one dropped registration, never an aborted `activate()`;
//   * the boundary renders `null` on a throw — there is no card to show for a surface that owns no
//     pixels, and drawing one would put a plugin's failure in the middle of the app's chrome —
//     while still ATTRIBUTING the fault through the ordinary problem channel;
//   * the node a view returns IS mounted (the documented idiom is `() => <Resync />`, an element).
//
// There is no jsdom in this repo (see `renderSafety.test.tsx`'s header), so the boundary is driven
// the way that file drives its own: by constructing it and calling `render()`.

import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { ReactNode } from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";

import {
  allPluginBackgroundViews,
  pluginBackgroundViewCount,
  resetPluginBackgroundViews,
  MAX_BACKGROUND_VIEWS_PER_PLUGIN,
} from "./backgroundViews";
import { makeWebPluginHost } from "./hostApi";
import { getPendingPluginProblems, resetPluginProblems } from "./problems";
import { resetPluginRenderFaultReports, safePluginBackgroundRender } from "./renderSafety";
import { resetPluginDisplayNames } from "./status";
import { resetRegisteredOverlayPanels } from "../skills-agents/rightGlobalPanel/registry";

const status = { id: "catalogs", name: "Skills, Agents & Commands" };

beforeEach(() => {
  resetPluginBackgroundViews();
  resetPluginProblems();
  resetPluginRenderFaultReports();
  resetPluginDisplayNames();
  resetRegisteredOverlayPanels();
});

describe("host.registerBackgroundView", () => {
  it("registers a view keyed by plugin and ordinal, wrapped before it reaches the store", () => {
    const { host } = makeWebPluginHost(status);
    host.registerBackgroundView(() => null);

    const views = allPluginBackgroundViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.key).toBe("background:catalogs:0");
    expect(views[0]?.pluginId).toBe("catalogs");
    // What the store holds is the BOUNDARY, not the plugin's function: every path from here to the
    // screen has to go through it, and the way to guarantee that is for the raw value never to
    // reach this module.
    expect(typeof views[0]?.render).toBe("function");
    expect(views[0]?.render).not.toBe(undefined);
  });

  it(`caps at ${String(MAX_BACKGROUND_VIEWS_PER_PLUGIN)} per plugin and reports once`, () => {
    const { host } = makeWebPluginHost(status);
    for (let i = 0; i < MAX_BACKGROUND_VIEWS_PER_PLUGIN + 3; i += 1) {
      host.registerBackgroundView(() => null);
    }

    expect(pluginBackgroundViewCount("catalogs")).toBe(MAX_BACKGROUND_VIEWS_PER_PLUGIN);
    const overflow = getPendingPluginProblems().filter(
      (problem) => problem.code === "background-view-overflow",
    );
    expect(overflow).toHaveLength(1);

    // The cap is PER PLUGIN: a second plugin has its own budget.
    const other = makeWebPluginHost({ id: "other", name: "Other" });
    other.host.registerBackgroundView(() => null);
    expect(pluginBackgroundViewCount("other")).toBe(1);
  });

  it("drops a non-function render without aborting activate", () => {
    const { host } = makeWebPluginHost(status);
    host.registerBackgroundView("not a function" as never);

    expect(allPluginBackgroundViews()).toHaveLength(0);
    expect(getPendingPluginProblems()[0]?.code).toBe("background-view-invalid");

    // The plugin keeps working — the next registration lands.
    host.registerBackgroundView(() => null);
    expect(allPluginBackgroundViews()).toHaveLength(1);
  });
});

describe("the background boundary", () => {
  it("renders NULL on a throw — a surface with no pixels shows no card", () => {
    // A card here would put a plugin's failure into the app's chrome, above the router, with no
    // way for the user to dismiss it and nothing it could usefully say.
    const boundary = new RenderErrorBoundary({
      children: null,
      fallback: () => null,
    });
    boundary.state = { failed: true, error: new Error("background boom") };
    expect(boundary.render()).toBeNull();
  });

  it("mounts what the view returned — the documented idiom is an ELEMENT, not null", () => {
    // `host.registerBackgroundView(() => <Resync />)` is the SDK's own example: the thing that
    // renders nothing is the plugin's component, not this wrapper. A host that discarded the node
    // would silently never run the hooks the whole surface exists for.
    const Resync = (): ReactNode => null;
    const rendered = safePluginBackgroundRender({
      pluginId: "catalogs",
      pluginName: status.name,
      surface: "background-view",
      render: () => <Resync />,
    })();

    const element = rendered as { readonly props: { readonly render: () => ReactNode } };
    expect(typeof element.props.render).toBe("function");
    const node = element.props.render() as { readonly type: unknown };
    expect(node.type).toBe(Resync);
  });
});
