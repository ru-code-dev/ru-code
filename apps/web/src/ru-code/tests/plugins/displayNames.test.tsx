// ru-code v2 (S15 B1): a plugin's DISPLAY NAME is something the host renders, so it needs a change
// signal (rules §26).
//
// WHY IT BECAME LOAD-BEARING. Until V2-27 the name only ever labelled a surface belonging to a
// plugin that had LOADED — a composer menu section, a fault card — so reading it from a plain
// module `Map` during render was always right: the loader records the name before it registers the
// plugin, and registering the plugin is what re-renders those surfaces. A tab-mounted panel broke
// that: the tab is PERSISTED, it is kept when its plugin is absent or failed (S15 A1/A2), and it is
// labelled with this name. For a plugin whose manifest row exists but whose web half fails to load,
// `addLoadedPlugin` is never reached — so nothing the strip watches moves, and the label sat on the
// plugin's id until an unrelated repaint happened along.
//
// WHAT IS PROVED HERE, and in what. `apps/web`'s unit project runs in NODE: there is no DOM and no
// commit loop, so "React re-rendered" cannot be observed directly. The two halves that make it true
// can:
//
//   1. the SIGNAL — `subscribePluginDisplayNames` fires when a name lands and stays quiet when the
//      same pairing is recorded again, and the snapshot's identity moves with it. That is exactly
//      what `useSyncExternalStore` compares, so a subscriber re-renders when and only when it must;
//   2. the WIRING — the tab strip renders the name out of that snapshot, falling back to the id,
//      for a surface whose plugin is not loaded at all.
//
// The browser half — a failed plugin's persisted tab correcting its own label with no other
// interaction — belongs to `ru-code/e2e/tests-plugins/`.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { RightPanelTabs } from "~/components/RightPanelTabs";

import {
  displayNameOf,
  pluginDisplayName,
  pluginDisplayNames,
  recordPluginDisplayName,
  resetPluginDisplayNames,
  subscribePluginDisplayNames,
} from "../../plugins/status";

const pluginSurface = {
  id: "plugin:demo:notes" as const,
  kind: "plugin" as const,
  pluginId: "demo",
  panelId: "notes",
};

/** The strip, with one tab whose plugin never loaded — the S15 A1/A2 degraded surface. */
const renderStrip = (): string =>
  renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={[pluginSurface]}
      activeSurfaceId={pluginSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddAgents={() => undefined}
      liveAgentCount={0}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      agentsAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );

beforeEach(() => {
  resetPluginDisplayNames();
});

describe("the display-name change signal", () => {
  it("fires when a name lands, and hands out a NEW snapshot", () => {
    const before = pluginDisplayNames();
    let fired = 0;
    const unsubscribe = subscribePluginDisplayNames(() => {
      fired += 1;
    });

    recordPluginDisplayName("demo", "Демо");
    expect(fired, "a subscriber hears about the name it is rendering").toBe(1);
    expect(pluginDisplayNames()).not.toBe(before);
    expect(pluginDisplayName("demo")).toBe("Демо");

    unsubscribe();
    recordPluginDisplayName("demo", "Other");
    expect(fired, "and nothing after it unsubscribed").toBe(1);
  });

  it("stays quiet when the loader re-records the SAME pairing", () => {
    recordPluginDisplayName("demo", "Демо");
    const snapshot = pluginDisplayNames();
    let fired = 0;
    const unsubscribe = subscribePluginDisplayNames(() => {
      fired += 1;
    });

    // Every pass records every manifest row; a repaint of the whole tab strip per reload is not a
    // change signal, it is noise.
    recordPluginDisplayName("demo", "Демо");
    expect(fired).toBe(0);
    expect(pluginDisplayNames(), "the identity React compares is untouched").toBe(snapshot);

    recordPluginDisplayName("demo", "Демо 2");
    expect(fired, "a real rename still gets through").toBe(1);
    unsubscribe();
  });

  it("resolves a name out of a snapshot, falling back to the id", () => {
    const names = new Map([
      ["demo", "Демо"],
      ["blank", "   "],
    ]);
    expect(displayNameOf(names, "demo")).toBe("Демо");
    expect(displayNameOf(names, "blank"), "an empty name is not a label").toBe("blank");
    expect(displayNameOf(names, "missing")).toBe("missing");
  });
});

describe("the tab strip's label for a plugin that is not loaded", () => {
  it("is the plugin's id while the host knows nothing else about it", () => {
    expect(renderStrip()).toContain("demo");
  });

  it("is the manifest name once the loader has recorded it", () => {
    recordPluginDisplayName("demo", "Демо-плагин");
    expect(renderStrip()).toContain("Демо-плагин");
  });
});
