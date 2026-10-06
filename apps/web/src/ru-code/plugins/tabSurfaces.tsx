// ru-code v2 (V2-27): plugin panels as TABS of the app's thread right panel.
//
// THE APP OWNS THE TABBED PANEL. `rightPanelStore.ts` holds an ordered set of surfaces PER THREAD
// (diff, files, a file, a browser tab, a terminal, a pull request, agents) and `RightPanelTabs.tsx`
// draws the strip, the launcher cards and the body. A plugin panel with `mount: "tab"` becomes one
// more surface kind — `plugin:<pluginId>:<panelId>` — and nothing about the app's model changes.
//
// WHAT THIS FILE IS. The plugins folder's side of that, so the app files gain a hook and a generic
// `plugin` branch and never learn a plugin's name (architecture.md §5, the rule that keeps the copy
// set copyable):
//
//   · `usePluginTabSurfaces()` — every tab-mounted panel, with its title, its lucide icon NAME, and
//     an `open()` bound to the thread the user is looking at;
//   · `PluginTabSurfaceBody` — the body, mounted the way every other rendered seam is (an ELEMENT
//     inside `PluginSlotBoundary` + `PluginSurface`, so a throw costs this tab and nothing else);
//   · `usePluginThreadSurfaces(ref)` — ONE line in `ChatView`: it publishes which thread owns the
//     panel right now, and reconciles tabs whose panel stopped being contributed.
//
// WHY THE THREAD REF IS PUBLISHED RATHER THAN PASSED. The panel is per thread, so opening a tab
// needs a `ScopedThreadRef` — and the two callers that open one are the launcher card (inside
// `RightPanelTabs`, which has no ref: the pull-request page mounts it with a synthetic one) and the
// sidebar footer (outside the chat entirely). `ChatView` is the one component that knows the
// answer, so it publishes it here, exactly as `PluginSignalBridge` publishes the app's other
// values into `signals.ts`. When `ChatView` is not mounted — the pull-request list, settings — the
// ref is `null`, every tab card is unavailable with the app's own "not here" hint, and `nav`
// entries are disabled. That is the honest answer rather than opening a tab on a panel the user is
// not looking at.
//
// MOUNT CHANGES FLOW THROUGH `ctx.invalidate("panels")` (V2-25): the runner recomputes, a panel
// that flipped to `"tab"` appears as a card, one that flipped back leaves, and a tab whose panel
// vanished is closed by the reconcile below.

import type { Panel } from "@smart-tools/plugin-sdk/host";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, type ComponentType } from "react";
import { create } from "zustand";

import { L } from "@ru-code/localization";

import {
  pluginPanelSurfaceId,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { drawnDescription, panelMount } from "@smart-tools/plugin-sdk/host-rules";

import { PluginSlotBoundary, PluginSurface } from "./PluginSurface";
import {
  splitPluginIds,
  usePanelsAuthority,
  usePluginPanels,
  usePluginPanelsPass,
  type PluginContribution,
} from "./seams";

/** The thread whose right panel a tab-mounted panel belongs to, or `null` off a chat. */
interface ThreadRefState {
  readonly ref: ScopedThreadRef | null;
}

const useThreadRefStore = create<ThreadRefState>(() => ({ ref: null }));

/** Non-reactive read — `ctx.closePanel` and other imperative callers. */
export function pluginThreadRef(): ScopedThreadRef | null {
  return useThreadRefStore.getState().ref;
}

/** Reactive read, for the surfaces below. */
export function usePluginThreadRef(): ScopedThreadRef | null {
  return useThreadRefStore((state) => state.ref);
}

/**
 * Publish the thread that owns the right panel.
 *
 * Called by {@link usePluginThreadSurfaces} — and directly by the unit tests, which have no DOM to
 * mount `ChatView` in.
 */
export function publishPluginThreadRef(ref: ScopedThreadRef | null): void {
  useThreadRefStore.setState({ ref });
}

/** Test seam — the ref is a module singleton, like the registry and the signals. */
export function resetPluginThreadRef(): void {
  publishPluginThreadRef(null);
}

/**
 * Is this panel mounted as a TAB (V2-27)?
 *
 * ONE predicate, used by both halves of the split: the tab surfaces below take the ones it accepts,
 * the global overlay registry (`slots.tsx`) takes the ones it rejects. `mount` is optional and its
 * DEFAULT is `"panel"`, so a plugin written before V2-27 keeps the slot it had.
 *
 * Pure and exported because `apps/web`'s unit project runs in the NODE environment: a rule that
 * lives only inside a hook is a rule only the e2e suite can check.
 */
export const isTabPanel = (entry: PluginContribution<Panel>): boolean =>
  panelMount(entry.value) === "tab";

/** The panels a plugin asked to mount as a TAB. */
export function usePluginTabPanels(): ReadonlyArray<PluginContribution<Panel>> {
  const panels = usePluginPanels();
  return useMemo(() => panels.filter(isTabPanel), [panels]);
}

/** One tab-mounted panel, as the app's right panel needs it. */
export interface PluginTabSurface {
  /** `plugin:<pluginId>:<panelId>` — the surface id in `rightPanelStore`. */
  readonly surfaceId: string;
  readonly pluginId: string;
  readonly panelId: string;
  readonly title: string;
  /**
   * `Panel.description` (S22) — the one line under the launcher card and the "+" menu entry.
   * `""` when the plugin gave none: the host substitutes nothing, so the card has no second line.
   */
  readonly description: string;
  /** A lucide icon NAME the HOST renders (V2-6) — never plugin React. */
  readonly icon: string | undefined;
  /** The label the plugin asked for in the sidebar footer, when it asked for one. */
  readonly navLabel: string | undefined;
  readonly navIcon: string | undefined;
  readonly render: ComponentType;
  /** `false` off a thread: there is no panel to open it in. */
  readonly available: boolean;
  /** Open it, or focus the tab it already has. A no-op when `available` is false. */
  readonly open: () => void;
  /**
   * Why `available` is false, for the surfaces that draw a greyed entry (S26 A5): the "+" menu is
   * mounted on `/pull-requests` too, where no thread is published, and the app's own entries there
   * carry a reason tooltip. `undefined` while available.
   */
  readonly unavailableReason: string | undefined;
}

/** The one reason a tab surface is ever unavailable: there is no thread to open it beside. */
const unavailableReason = (): string => L("Available from a thread.", "Доступно из диалога.");

/** One contributed panel as a tab surface. Pure — see {@link isTabPanel} for why it is exported. */
export const toPluginTabSurface = (
  entry: PluginContribution<Panel>,
  ref: ScopedThreadRef | null,
): PluginTabSurface => ({
  surfaceId: pluginPanelSurfaceId(entry.pluginId, entry.value.id),
  pluginId: entry.pluginId,
  panelId: entry.value.id,
  title: entry.value.title,
  // The plugin's own line, drawn as given and clamped here (the SDK's `drawnDescription`);
  // `""` is "none" — an absent, blank or whitespace description all read the same.
  description: drawnDescription(entry.value.description),
  icon: entry.value.icon,
  navLabel: entry.value.nav?.label,
  navIcon: entry.value.nav?.icon ?? entry.value.icon,
  render: entry.value.render,
  available: ref !== null,
  unavailableReason: ref === null ? unavailableReason() : undefined,
  open: () => {
    if (ref === null) return;
    useRightPanelStore.getState().openPluginPanel(ref, entry.pluginId, entry.value.id);
  },
});

/** Every tab-mounted panel, in manifest order, bound to the thread on screen. */
export function usePluginTabSurfaces(): ReadonlyArray<PluginTabSurface> {
  const panels = usePluginTabPanels();
  const ref = usePluginThreadRef();
  return useMemo(() => panels.map((entry) => toPluginTabSurface(entry, ref)), [panels, ref]);
}

/** The panel behind one open tab, or `null` while the plugin is not contributing it. */
export function usePluginTabSurface(surfaceId: string): PluginTabSurface | null {
  const surfaces = usePluginTabSurfaces();
  return surfaces.find((surface) => surface.surfaceId === surfaceId) ?? null;
}

/**
 * The body of a plugin tab.
 *
 * Two boundaries, for the reason `slots.tsx` states for the global slot: React routes an
 * unmount-phase throw past the inner one, and without the outer one the whole tab strip would go
 * down with the plugin. The surface name carries the panel id so two tabs of one plugin report
 * their faults separately.
 */
export function PluginTabSurfaceBody(props: {
  readonly surface: { readonly id: string; readonly pluginId: string; readonly panelId: string };
}) {
  const panel = usePluginTabSurface(props.surface.id);
  // S15 A1/A2: `null` is the DEGRADED tab, and it is a state the user can now sit in rather than a
  // single frame. A persisted tab whose plugin is missing, still loading or broken is kept (the
  // reconcile will not delete on silence), so the strip shows it with the plugin's name and the
  // body shows nothing — the same "the panel is not here right now" the global slot renders when
  // its plugin is gone (`RightGlobalPanelHost`), and it fills in by itself when the plugin returns.
  if (panel === null) return null;
  return (
    <PluginSlotBoundary pluginId={panel.pluginId}>
      <PluginSurface
        pluginId={panel.pluginId}
        render={panel.render}
        surface={`tab:${panel.panelId}`}
      />
    </PluginSlotBoundary>
  );
}

/**
 * `ctx.closePanel(id)` for a TAB-mounted panel (V2-27) — the tab half of `slots.ts`'s rule.
 *
 * Scoped to the caller exactly as the global one is: the id is composed with the plugin's own id,
 * so a plugin can only ever close one of its own tabs, and only on the thread whose panel is on
 * screen. `closeSurface` is a no-op for a surface that is not open, so nothing else has to be
 * checked here.
 */
export function closePluginTabSurface(pluginId: string, panelId: string): boolean {
  const ref = pluginThreadRef();
  if (ref === null) return false;
  const surfaceId = pluginPanelSurfaceId(pluginId, panelId);
  const state = useRightPanelStore.getState();
  const thread = selectThreadRightPanelState(state.byThreadKey, ref);
  // Answer whether this call was OURS to make, so `ctx.closePanel` can fall through to the global
  // slot for a panel that is mounted there instead.
  if (!thread.surfaces.some((surface) => surface.id === surfaceId)) return false;
  state.closeSurface(ref, surfaceId);
  return true;
}

/**
 * ONE line in `ChatView`: publish the thread that owns the right panel, and keep its plugin tabs
 * honest.
 *
 * The reconcile runs on every change to the tab-mounted set — which is what
 * `ctx.invalidate("panels")` moves — so a panel that stops being contributed takes its tab with it
 * instead of leaving a tab whose body renders nothing.
 *
 * WHAT IT WILL NOT DO (S15 A1/A2). It deletes a PERSISTED surface, so it acts only on evidence,
 * and there are two independent gates:
 *
 *   · the loader's pass must have READ a plugin list. Before the first pass, and on any pass that
 *     never reached `manifests.json`, the empty registry says nothing about any plugin;
 *   · the tab's own plugin must be AUTHORITATIVE on this pass — present in the registry (so it
 *     loaded: not uninstalled, not disabled, not failed, not timed out, not still loading) and its
 *     `panels` seam did not fault. A tab whose plugin is anything else is KEPT and renders empty.
 *
 * So the only tab this closes is one whose plugin is right there, working, and no longer offering
 * that panel as a tab — the panel was dropped, or its `mount` flipped back to the global slot.
 */
export function usePluginThreadSurfaces(ref: ScopedThreadRef | null): void {
  // Plugins load AFTER first paint, and a tab is PERSISTED: reconciling against the pre-load list
  // closes the user's restored tab about a second before its plugin arrives. Measured —
  // `pluginTabs.e2e.test.ts`'s per-thread case failed on exactly that, and this is the fix.
  // The PASS, not `usePluginTabSurfaces()`: this hook needs the faults as well as the entries, and
  // it needs no `open()` — asking the seam twice per render would double every fault report.
  const panels = usePluginPanelsPass();
  const authority = usePanelsAuthority(panels);
  const surfaceIds = useMemo(
    () =>
      panels.entries
        .filter(isTabPanel)
        .map((entry) => pluginPanelSurfaceId(entry.pluginId, entry.value.id))
        .join(" "),
    [panels],
  );

  useEffect(() => {
    publishPluginThreadRef(ref);
    return () => {
      // Only clear what we published: a second chat mounting before the first unmounts (React's
      // StrictMode double-invoke, or a route transition) must not blank the newer one's ref.
      if (pluginThreadRef() === ref) publishPluginThreadRef(null);
    };
  }, [ref]);

  useEffect(() => {
    if (ref === null || authority.pass !== "read") return;
    useRightPanelStore
      .getState()
      .reconcilePluginSurfaces(
        ref,
        splitPluginIds(surfaceIds),
        splitPluginIds(authority.pluginIds),
      );
  }, [authority, ref, surfaceIds]);
}
