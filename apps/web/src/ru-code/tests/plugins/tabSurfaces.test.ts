// ru-code v2 (V2-27): plugin panels as TABS of the app's thread right panel.
//
// WHAT THIS FILE PROVES. Everything the mechanism is, minus React: the store surface a tab IS, the
// rule that decides which slot a panel goes to, the per-thread singleton, the reconcile that closes
// a tab whose panel stopped being contributed, and `ctx.closePanel`'s tab arm. `apps/web`'s unit
// project runs in the NODE environment (no jsdom in this repo), so the two HOOKS — the runner that
// feeds the launcher cards and the one line in `ChatView` that publishes the thread — are proved in
// a real browser by `ru-code/e2e/tests-plugins/pluginTabs.e2e.test.ts`.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { Panel } from "@smart-tools/plugin-sdk/host";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  pluginPanelSurfaceId,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { pluginPanelId } from "../../skills-agents/rightGlobalPanel/store";
import { resetLoadedPlugins } from "../../plugins/registry";
import {
  closePluginPanel,
  pageNavEntry,
  tabNavEntry,
  vanishedPluginGlobalPanel,
} from "../../plugins/slots";
import type { PluginContribution } from "../../plugins/seams";
import {
  isTabPanel,
  publishPluginThreadRef,
  resetPluginThreadRef,
  toPluginTabSurface,
} from "../../plugins/tabSurfaces";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

const Nothing = () => null;

const contribution = (
  pluginId: string,
  panel: Partial<Panel> & { readonly id: string },
): PluginContribution<Panel> => ({
  pluginId,
  pluginName: pluginId.toUpperCase(),
  key: `plugin:${pluginId}:${panel.id}`,
  value: { title: panel.id, render: Nothing, ...panel },
  ctx: {} as never,
});

const surfaces = (ref: typeof refA) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces;
const ids = (ref: typeof refA) => surfaces(ref).map((surface) => surface.id);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  resetPluginThreadRef();
  resetLoadedPlugins();
});

describe("isTabPanel", () => {
  it("is the DEFAULT that decides: no `mount` is the global slot, as it was before V2-27", () => {
    expect(isTabPanel(contribution("demo", { id: "notes" }))).toBe(false);
    expect(isTabPanel(contribution("demo", { id: "notes", mount: "panel" }))).toBe(false);
    expect(isTabPanel(contribution("demo", { id: "notes", mount: "tab" }))).toBe(true);
  });
});

describe("toPluginTabSurface", () => {
  const entry = contribution("catalogs", {
    id: "agents",
    title: "Агенты",
    icon: "Bot",
    mount: "tab",
    nav: { label: "Агенты" },
  });

  it("carries the plugin's own title and its lucide icon NAME, never its React", () => {
    const surface = toPluginTabSurface(entry, refA);
    expect(surface.surfaceId).toBe("plugin:catalogs:agents");
    expect(surface.title).toBe("Агенты");
    expect(surface.icon).toBe("Bot");
    expect(surface.navLabel).toBe("Агенты");
    // The nav falls back to the panel's own icon when the entry names none.
    expect(surface.navIcon).toBe("Bot");
  });

  it("is UNAVAILABLE off a thread — there is no right panel to open it in", () => {
    const surface = toPluginTabSurface(entry, null);
    expect(surface.available).toBe(false);
    surface.open();
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  // S26 A5: the "+" menu is drawn on `/pull-requests` too, where no thread is published; there the
  // entry is greyed and must SAY why, as the app's own six entries do.
  it("names the reason when it is unavailable, and none when it is not", () => {
    expect(toPluginTabSurface(entry, null).unavailableReason).toMatch(
      /^(Available from a thread\.|Доступно из диалога\.)$/,
    );
    expect(toPluginTabSurface(entry, refA).unavailableReason).toBeUndefined();
  });

  // S26 A1: an empty or whitespace `description` is "none" — the card gets no second line — and
  // a given one comes through as the plugin wrote it.
  it("reads a blank `description` as none, and a given one verbatim", () => {
    expect(toPluginTabSurface(entry, refA).description).toBe("");
    expect(
      toPluginTabSurface(contribution("p", { id: "a", description: "" }), refA).description,
    ).toBe("");
    expect(
      toPluginTabSurface(contribution("p", { id: "a", description: " \t " }), refA).description,
    ).toBe("");
    expect(
      toPluginTabSurface(contribution("p", { id: "a", description: "Notes" }), refA).description,
    ).toBe("Notes");
    // MOVED at S41 item 2: these two used to read as none — the host judged the string and drew
    // nothing. It no longer judges it: a multi-line line is drawn as given (the card's own
    // `line-clamp` is what bounds it), and an over-long one is CLAMPED rather than dropped.
    expect(
      toPluginTabSurface(contribution("p", { id: "a", description: "two\nlines" }), refA)
        .description,
    ).toBe("two\nlines");
    expect(
      toPluginTabSurface(contribution("p", { id: "a", description: "x".repeat(1001) }), refA)
        .description,
    ).toBe("x".repeat(1000));
  });
});

describe("openPluginPanel", () => {
  it("opens the tab on THIS thread and activates it", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    expect(ids(refA)).toEqual(["plugin:catalogs:agents"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "plugin:catalogs:agents",
      kind: "plugin",
      pluginId: "catalogs",
      panelId: "agents",
    });
  });

  it("is a SINGLETON by id: opening it again focuses the tab, never a second one", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "skills");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    expect(ids(refA)).toEqual(["plugin:catalogs:agents", "plugin:catalogs:skills"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plugin:catalogs:agents",
    );
  });

  it("is PER THREAD, like diff and files (V2-27)", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    expect(ids(refB)).toEqual([]);
    useRightPanelStore.getState().openPluginPanel(refB, "catalogs", "agents");
    expect(ids(refA)).toEqual(["plugin:catalogs:agents"]);
    expect(ids(refB)).toEqual(["plugin:catalogs:agents"]);
  });
});

describe("reconcilePluginSurfaces", () => {
  it("closes a tab whose panel is no longer contributed, and leaves the app's own alone", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "skills");

    useRightPanelStore
      .getState()
      .reconcilePluginSurfaces(refA, ["plugin:catalogs:skills"], ["catalogs"]);
    expect(ids(refA)).toEqual(["diff", "plugin:catalogs:skills"]);
  });

  it("moves the active tab to a survivor when the active one was the one that vanished", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "plugin:catalogs:agents",
    );

    useRightPanelStore.getState().reconcilePluginSurfaces(refA, [], ["catalogs"]);
    expect(ids(refA)).toEqual(["diff"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "diff",
    );
  });

  it("changes nothing when every open tab is still contributed", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    const before = useRightPanelStore.getState().byThreadKey;
    useRightPanelStore
      .getState()
      .reconcilePluginSurfaces(
        refA,
        ["plugin:catalogs:agents", "plugin:demo:notes-tab"],
        ["catalogs", "demo"],
      );
    // Identity, not equality: a re-render on every reconcile is what this must not cost.
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  // S15 A2. The list of what is contributed answers "should this tab still be here?" only for the
  // plugins that ANSWERED. For everyone else it is silence, and a persisted tab is the user's.
  it("KEEPS the tab of a plugin that is not there — uninstalled, disabled, failed, still loading", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");

    // `demo` is loaded and contributing; `catalogs` is not in the registry at all.
    useRightPanelStore
      .getState()
      .reconcilePluginSurfaces(refA, ["plugin:demo:notes-tab"], ["demo"]);
    expect(ids(refA)).toEqual(["plugin:catalogs:agents", "plugin:demo:notes-tab"]);
  });

  it("KEEPS the tab of a loaded plugin whose panels seam FAULTED (it is absent from authority)", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    // `catalogs` is loaded, but it threw this pass, so it contributed nothing AND is not
    // authoritative. Contributing nothing while authoritative is what closes a tab; this is not it.
    useRightPanelStore.getState().reconcilePluginSurfaces(refA, [], []);
    expect(ids(refA)).toEqual(["plugin:catalogs:agents"]);
  });

  it("closes only the one that vanished when a plugin keeps SOME of its panels", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "agents");
    useRightPanelStore.getState().openPluginPanel(refA, "catalogs", "skills");
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");

    // catalogs answered and no longer offers `agents`; demo is missing entirely.
    useRightPanelStore
      .getState()
      .reconcilePluginSurfaces(refA, ["plugin:catalogs:skills"], ["catalogs"]);
    expect(ids(refA)).toEqual(["plugin:catalogs:skills", "plugin:demo:notes-tab"]);
  });

  it("closes the tab of a panel whose `mount` flipped back to the global slot", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");
    // The panel is still contributed — as a PANEL, so it is not in the tab list the caller passes.
    useRightPanelStore.getState().reconcilePluginSurfaces(refA, [], ["demo"]);
    expect(ids(refA)).toEqual([]);
  });
});

// S15 A6: the sidebar footer maps pages and tabs into ONE list, so their keys share a namespace.
describe("footer nav keys", () => {
  const page = (pluginId: string, id: string) => ({
    pluginId,
    pluginName: pluginId.toUpperCase(),
    key: `plugin:${pluginId}:${id}`,
    value: { id, title: id, render: Nothing, nav: { label: id } },
    ctx: {} as never,
  });

  it("cannot collide when a plugin gives a page and a tab-mounted panel the SAME id", () => {
    const pageEntry = pageNavEntry(page("demo", "notes"), () => {});
    const tabEntry = tabNavEntry(
      toPluginTabSurface(
        contribution("demo", { id: "notes", mount: "tab", nav: { label: "Notes" } }),
        refA,
      ),
    );
    expect(pageEntry?.key).toBe("plugin:demo:notes");
    expect(tabEntry?.key).toBe("tab:plugin:demo:notes");
    expect(tabEntry?.key).not.toBe(pageEntry?.key);
  });

  it("is absent for a tab-mounted panel that asked for no footer entry", () => {
    expect(tabNavEntry(toPluginTabSurface(contribution("demo", { id: "notes" }), refA))).toBe(null);
  });
});

// S15 A5: the OPEN global panel is state too, and nothing was keeping it honest.
describe("vanishedPluginGlobalPanel", () => {
  it("names the plugin panel that is open and no longer contributed", () => {
    expect(
      vanishedPluginGlobalPanel(pluginPanelId("demo", "notes"), ["plugin:demo:other"], ["demo"]),
    ).toBe("plugin:demo:notes");
  });

  it("leaves a panel that is still contributed alone", () => {
    expect(
      vanishedPluginGlobalPanel(pluginPanelId("demo", "notes"), ["plugin:demo:notes"], ["demo"]),
    ).toBe(null);
  });

  it("never touches a BUILT-IN panel, whatever the plugins are doing", () => {
    expect(vanishedPluginGlobalPanel("mcp", [], ["demo"])).toBe(null);
    expect(vanishedPluginGlobalPanel(null, [], ["demo"])).toBe(null);
  });

  it("keeps the panel of a plugin that is not authoritative — the same silence rule as a tab", () => {
    expect(vanishedPluginGlobalPanel(pluginPanelId("demo", "notes"), [], [])).toBe(null);
    expect(vanishedPluginGlobalPanel(pluginPanelId("demo", "notes"), [], ["catalogs"])).toBe(null);
  });
});

describe("ctx.closePanel on a tab (V2-27)", () => {
  it("closes the plugin's OWN tab on the thread the user is looking at", () => {
    // The ref `ChatView` publishes through `usePluginThreadSurfaces`; there is no DOM here.
    publishPluginThreadRef(refA);
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");
    closePluginPanel("demo", "notes-tab");
    expect(ids(refA)).toEqual([]);
  });

  it("cannot close ANOTHER plugin's tab", () => {
    publishPluginThreadRef(refA);
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");
    closePluginPanel("catalogs", "notes-tab");
    expect(ids(refA)).toEqual(["plugin:demo:notes-tab"]);
  });

  it("does nothing off a thread: with no panel on screen there is no tab to close", () => {
    useRightPanelStore.getState().openPluginPanel(refA, "demo", "notes-tab");
    resetPluginThreadRef();
    closePluginPanel("demo", "notes-tab");
    expect(ids(refA)).toEqual(["plugin:demo:notes-tab"]);
  });

  it("leaves a GLOBAL-slot panel to the global slot's own rule", () => {
    // `closePluginPanel` tries the tab first and falls through; with a thread published but no tab
    // of that id open, the global arm runs and closes nothing here (its own test covers the rest).
    publishPluginThreadRef(refA);
    useRightPanelStore.getState().open(refA, "diff");
    closePluginPanel("catalogs", "commands");
    expect(ids(refA)).toEqual(["diff"]);
  });
});

describe("the persisted surface", () => {
  const persisted = (surface: unknown) =>
    migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": { isOpen: true, activeSurfaceId: null, surfaces: [surface] },
      },
    }).byThreadKey["env-1:thread-A"]?.surfaces ?? [];

  it("keeps a well-formed tab — a plugin that is simply not loaded YET must not lose its tab", () => {
    expect(
      persisted({
        id: pluginPanelSurfaceId("catalogs", "agents"),
        kind: "plugin",
        pluginId: "catalogs",
        panelId: "agents",
      }),
    ).toEqual([
      { id: "plugin:catalogs:agents", kind: "plugin", pluginId: "catalogs", panelId: "agents" },
    ]);
  });

  it.each([
    { id: "plugin:catalogs:agents", kind: "plugin", pluginId: "catalogs" },
    { id: "plugin:catalogs:agents", kind: "plugin", pluginId: "catalogs", panelId: "" },
    { id: "plugin:other:agents", kind: "plugin", pluginId: "catalogs", panelId: "agents" },
    { id: "plugin:catalogs:agents", kind: "plugin", pluginId: 7, panelId: "agents" },
  ])("drops %o — the id and its two halves have to agree", (surface) => {
    expect(persisted(surface)).toEqual([]);
  });
});
