// ru-code: the panel registry is REACTIVE (A4 findings H2 + M2).
//
// Plugins used to be awaited before `createRoot(...)`, which is what let the registry be a
// plain map — and which let one hanging plugin white-screen the app. They load after the first
// paint now, so the registry is a store and every nav reads it through a hook. The property
// under test: a panel registered AFTER a render is observed by the readers, and the readers
// really do read the store (not a captured snapshot of the seed array).

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  navPanels,
  overlayPanels,
  registerOverlayPanel,
  resetRegisteredOverlayPanels,
  useNavPanels,
  useOverlayPanels,
  OVERLAY_PANELS,
} from "../skills-agents/rightGlobalPanel/registry";
import { makeGlobalPanelId } from "../skills-agents/rightGlobalPanel/store";

const Icon = () => null;

const panel = (id: string, label: string, navHidden?: boolean) => {
  const panelId = makeGlobalPanelId(id);
  if (panelId === null) throw new Error(`bad test id ${id}`);
  return {
    id: panelId,
    label,
    icon: Icon,
    ...(navHidden === undefined ? {} : { navHidden }),
    render: () => null,
  };
};

/** Probe components: the only legal way to call the hooks. */
function OverlayProbe() {
  return (
    <ul>
      {useOverlayPanels().map((entry) => (
        <li key={entry.id}>{entry.label}</li>
      ))}
    </ul>
  );
}
function NavProbe() {
  return (
    <ul>
      {useNavPanels().map((entry) => (
        <li key={entry.id}>{entry.label}</li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  resetRegisteredOverlayPanels();
});

describe("useOverlayPanels / useNavPanels", () => {
  it("render the seed panels when nothing registered", () => {
    const html = renderToStaticMarkup(<OverlayProbe />);
    for (const seed of OVERLAY_PANELS) {
      expect(html).toContain(seed.label);
    }
  });

  it("include a plugin panel registered BEFORE the render", () => {
    registerOverlayPanel(panel("plugin:demo", "Demo Panel"));
    expect(renderToStaticMarkup(<OverlayProbe />)).toContain("Demo Panel");
    expect(renderToStaticMarkup(<NavProbe />)).toContain("Demo Panel");
  });

  it("include a plugin panel registered AFTER a first render — the whole point", () => {
    // First paint: no plugin has activated yet (this is now the normal boot order).
    expect(renderToStaticMarkup(<OverlayProbe />)).not.toContain("Late Panel");
    registerOverlayPanel(panel("plugin:late", "Late Panel"));
    expect(renderToStaticMarkup(<OverlayProbe />)).toContain("Late Panel");
    expect(renderToStaticMarkup(<NavProbe />)).toContain("Late Panel");
  });

  it("still honour navHidden", () => {
    registerOverlayPanel(panel("plugin:demo:detail", "Hidden Panel", true));
    expect(renderToStaticMarkup(<OverlayProbe />)).toContain("Hidden Panel");
    expect(renderToStaticMarkup(<NavProbe />)).not.toContain("Hidden Panel");
  });
});

describe("the store notifies", () => {
  it("a registration wakes every subscriber, which is what re-renders the navs", () => {
    // `useOverlayPanels` is `create(...)` sugar over exactly this subscription, so a
    // notification here IS the re-render in the app.
    const seen: number[] = [];
    let previous = overlayPanels().length;
    seen.push(previous);
    registerOverlayPanel(panel("plugin:demo", "Demo Panel"));
    previous = overlayPanels().length;
    seen.push(previous);
    expect(seen[1]).toBe(seen[0]! + 1);
    expect(navPanels().some((entry) => entry.label === "Demo Panel")).toBe(true);
    resetRegisteredOverlayPanels();
    expect(overlayPanels()).toHaveLength(seen[0]!);
  });

  it("a duplicate registration replaces rather than growing the store", () => {
    registerOverlayPanel(panel("plugin:demo", "First"));
    registerOverlayPanel(panel("plugin:demo", "Second"));
    const html = renderToStaticMarkup(<OverlayProbe />);
    expect(html).toContain("Second");
    expect(html).not.toContain("First");
  });
});
