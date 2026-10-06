// ru-code v2: the SLOT adapters — the plugins folder's side of every hook in an app file.
//
// The rule this file exists for (architecture.md §5): the slot components live HERE, not in a
// feature folder. v1 put the panel registry, the panel store and the reactive nav inside
// `skills-agents/rightGlobalPanel/`, a folder named after the feature that used to own it — which
// is the one part of the plugin system a fresh fork cannot copy. Everything below is plugin code
// that speaks the app's shapes, so each app file gains ONE line.

import type { Page, Panel } from "@smart-tools/plugin-sdk/host";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import type { OverlayPanel } from "../skills-agents/rightGlobalPanel/registry";
import {
  pluginPanelId,
  useRightGlobalPanelStore,
  type GlobalPanelId,
} from "../skills-agents/rightGlobalPanel/store";

import { clampPanelWidth } from "@smart-tools/plugin-sdk/host-rules";

import { pluginIconComponent } from "./PluginIcon";
import { PluginSlotBoundary, PluginSurface } from "./PluginSurface";
import {
  splitPluginIds,
  usePanelsAuthority,
  usePluginPages,
  usePluginPanelsPass,
  type PluginContribution,
} from "./seams";
import {
  closePluginTabSurface,
  isTabPanel,
  usePluginTabSurfaces,
  type PluginTabSurface,
} from "./tabSurfaces";

/**
 * A plugin panel as the app's right-hand slot understands it.
 *
 * The two things that cross: an icon COMPONENT the host built from a lucide name (never the
 * plugin's own React — decision V2-6), and a `render` that mounts the plugin's component inside
 * `PluginSurface` and one more boundary. The extra `PluginSlotBoundary` is not belt and braces:
 * React routes an unmount-phase throw past the inner boundary, and without it the whole panel host
 * would go down with the plugin.
 */
const toOverlayPanel = (entry: PluginContribution<Panel>, id: GlobalPanelId): OverlayPanel => {
  // The width a panel opens at, clamped (the SDK's rule). A plugin asks; the user's drag still wins.
  const width = clampPanelWidth(entry.value.width);
  return {
    id,
    label: entry.value.title,
    icon: pluginIconComponent(entry.value.icon),
    ...(width === undefined ? {} : { preferredWidth: width }),
    // The panel is only in a nav when the plugin asked for one.
    ...(entry.value.nav === undefined ? { navHidden: true } : {}),
    render: () => (
      <PluginSlotBoundary pluginId={entry.pluginId}>
        {/* The surface name carries the ENTRY id: faults are reported once per plugin per
            surface, so two panels of one plugin sharing the name "panel" would report once
            between them and the second one's failure would be invisible. */}
        <PluginSurface
          pluginId={entry.pluginId}
          render={entry.value.render}
          surface={`panel:${entry.value.id}`}
        />
      </PluginSlotBoundary>
    ),
  };
};

/**
 * Every plugin panel, as overlay panels.
 *
 * Consumed by ONE line in `skills-agents/rightGlobalPanel/registry.tsx`. A panel whose id is not a
 * legal slug is dropped by `pluginPanelId` returning `null` — the seam runner already refused
 * anything that is not a slug, so this is the second gate on the same rule rather than a new one.
 */
export function usePluginOverlayPanels(): readonly OverlayPanel[] {
  const panels = usePluginPanelsPass();
  const authority = usePanelsAuthority(panels);
  const out = useMemo(() => {
    const list: OverlayPanel[] = [];
    for (const entry of panels.entries) {
      // V2-27: a panel the plugin asked to mount as a TAB belongs to the thread's right panel
      // (`tabSurfaces.tsx`), and must not ALSO appear in the global slot — one panel, one home.
      if (isTabPanel(entry)) continue;
      const id = pluginPanelId(entry.pluginId, entry.value.id);
      if (id === null) continue;
      list.push(toOverlayPanel(entry, id));
    }
    return list;
  }, [panels]);
  const contributedIds = useMemo(() => out.map((panel) => panel.id).join(" "), [out]);

  // S15 A5: the OPEN global panel is state too, and the tab half was the only half keeping it
  // honest. `useRightGlobalPanelStore.open` is an id, not a subscription: when the panel it names
  // stops being contributed — the plugin flipped it to `mount: "tab"`, or dropped it — the host
  // renders nothing and the right slot stays occupied by a panel that no longer exists, with the
  // thread's own panel hidden behind it. Closing it hands the slot back.
  //
  // Same two gates as the tab reconcile, for the same reason (S15 A1/A2): an uninstalled, still
  // loading or broken plugin has NOT said its panel is gone, and the existing degraded posture for
  // that case — `RightGlobalPanelHost` rendering nothing while `open` stands — is deliberate, so
  // the panel comes back when the plugin does.
  //
  // In the hook rather than beside the store: this is the one place that knows what is contributed.
  // Two components call it (`RightGlobalPanelHost` and the sidebar's nav), so it can run twice —
  // it is idempotent, and the second run sees `open` already cleared.
  useEffect(() => {
    if (authority.pass !== "read") return;
    const store = useRightGlobalPanelStore.getState();
    const vanished = vanishedPluginGlobalPanel(
      store.open,
      splitPluginIds(contributedIds),
      splitPluginIds(authority.pluginIds),
    );
    if (vanished !== null) store.close();
  }, [authority, contributedIds]);

  return out;
}

/**
 * The open global panel, when it is a plugin's and that plugin is no longer offering it. `null`
 * when nothing should be closed.
 *
 * Pure and exported for the reason `isTabPanel` is: this project's web unit project runs in the
 * NODE environment, so a rule that lives only inside an effect is a rule only the e2e suite can
 * check. The three answers it must get right: a BUILT-IN panel is never touched (its id is not a
 * plugin's); a plugin that is not authoritative is never touched (silence is not an answer); and a
 * panel that is still contributed is never touched.
 */
export function vanishedPluginGlobalPanel(
  open: GlobalPanelId | null,
  contributedIds: readonly string[],
  authoritativePluginIds: readonly string[],
): GlobalPanelId | null {
  if (open === null) return null;
  const pluginId = pluginIdFromPanelId(open);
  if (pluginId === null) return null;
  if (!authoritativePluginIds.includes(pluginId)) return null;
  return contributedIds.includes(open) ? null : open;
}

/**
 * `ctx.closePanel(id)` (V2-15) — the plugins folder's side of the app's overlay store.
 *
 * WHY IT IS NOT A PROP. The app's overlay host does compute an `onClose`, and the obvious fix was to
 * hand it to `Panel.render`. But `render` is a `ComponentType` with NO props by design (S1 §6.1:
 * a component built per call remounts on every host repaint), so widening it would have widened the
 * one rule that keeps plugin components stable. A ctx method costs the plugin nothing and can be
 * called from anywhere in its tree, including a nested dialog.
 *
 * SCOPED TO THE CALLER. The id is composed with the plugin's own id, so the only panel a plugin can
 * name is one of its own; and the close is conditional on THAT panel being the open one, so a
 * background loop calling it while another plugin's panel is open cannot shut the user's panel.
 */
export function closePluginPanel(pluginId: string, panelId: string): void {
  // V2-27: the panel may be mounted as a TAB of the thread's right panel instead. The tab half
  // answers whether the id was one of its own, so a plugin writes `ctx.closePanel(id)` once and
  // the host decides which slot that panel is in — including after a `mount` change.
  if (closePluginTabSurface(pluginId, panelId)) return;
  const target = pluginPanelId(pluginId, panelId);
  const store = useRightGlobalPanelStore.getState();
  if (target !== null && store.open === target) store.close();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Footer navigation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A footer entry a plugin asked for — a PAGE to navigate to, or a TAB to open (V2-27).
 *
 * ONE shape for both, with the action already bound: the sidebar renders an icon and calls
 * `activate()`. It does not navigate, does not know the route and does not know the right panel —
 * which is the rule that keeps `SidebarChrome`'s hunk one `.map` over plain data.
 */
export interface PluginPageNavEntry {
  readonly key: string;
  readonly label: string;
  readonly icon: string | undefined;
  /** `/plugins/<pluginId>/<pageId>` for a page; `null` for a tab, which has no route. */
  readonly to: string | null;
  readonly pluginId: string;
  /** The page id, or the panel id for a tab entry. */
  readonly pageId: string;
  /** A tab entry off a thread: there is no right panel to open it in. */
  readonly disabled: boolean;
  readonly activate: () => void;
}

/** `plugin:<pluginId>[:<panelId>]` → the plugin id; `null` for a built-in panel. */
export function pluginIdFromPanelId(panelId: string | null): string | null {
  if (panelId === null) return null;
  const [prefix, pluginId] = panelId.split(":");
  return prefix === "plugin" && pluginId !== undefined && pluginId !== "" ? pluginId : null;
}

/** Exported pure, like every other rule in this folder, so the NODE unit project can check it. */
export const pageNavEntry = (
  entry: PluginContribution<Page>,
  navigate: (to: string) => void,
): PluginPageNavEntry | null => {
  const nav = entry.value.nav;
  if (nav === undefined) return null;
  const to = `/plugins/${entry.pluginId}/${entry.value.id}`;
  return {
    key: entry.key,
    label: nav.label,
    icon: nav.icon ?? entry.value.icon,
    to,
    pluginId: entry.pluginId,
    pageId: entry.value.id,
    disabled: false,
    activate: () => {
      navigate(to);
    },
  };
};

/**
 * A TAB-mounted panel's footer entry (V2-27). Exported pure beside {@link pageNavEntry}, which is
 * the one it has to stay distinct from.
 *
 * S15 A6 — the key is NAMESPACED. A page's key is `plugin:<pluginId>:<pageId>` and a tab surface's
 * id is `plugin:<pluginId>:<panelId>`: the same string whenever a plugin gives a page and a
 * tab-mounted panel the same id, which is the natural thing to do for one feature with a
 * full-window view and a side view. The sidebar footer maps both families into ONE list, so React
 * would see two children with one key and render only one of the two buttons.
 */
export const tabNavEntry = (surface: PluginTabSurface): PluginPageNavEntry | null =>
  surface.navLabel === undefined
    ? null
    : {
        key: `tab:${surface.surfaceId}`,
        label: surface.navLabel,
        icon: surface.navIcon,
        to: null,
        pluginId: surface.pluginId,
        pageId: surface.panelId,
        // A tab entry off a thread: present and disabled rather than silently doing nothing.
        disabled: !surface.available,
        activate: surface.open,
      };

/**
 * The footer entries the sidebar renders for plugins — pages first, then panels.
 *
 * Consumed by ONE line in `components/sidebar/SidebarChrome.tsx`. A panel mounted in the GLOBAL
 * slot reaches the sidebar through the overlay-panel nav instead (that is what `navHidden` above
 * decides), so it is deliberately absent here — duplicating it would give a plugin two buttons for
 * one panel. A panel mounted as a TAB (V2-27) has no overlay entry to reach the rail with, so its
 * `nav` comes through here.
 */
export function usePluginNavEntries(): ReadonlyArray<PluginPageNavEntry> {
  const pages = usePluginPages();
  const tabs = usePluginTabSurfaces();
  const navigate = useNavigate();
  return useMemo(() => {
    const goTo = (to: string): void => {
      void navigate({ to });
    };
    const pageEntries = pages
      .map((entry) => pageNavEntry(entry, goTo))
      .filter((entry): entry is PluginPageNavEntry => entry !== null);
    // V2-27: a TAB-mounted panel's footer entry. It cannot come from the overlay-panel nav — the
    // tab is not in that registry at all — and it opens on the thread whose panel is on screen, so
    // off a chat it is present and DISABLED rather than silently doing nothing.
    const tabEntries = tabs.flatMap<PluginPageNavEntry>((surface) => {
      const entry = tabNavEntry(surface);
      return entry === null ? [] : [entry];
    });
    return [...pageEntries, ...tabEntries];
  }, [navigate, pages, tabs]);
}
