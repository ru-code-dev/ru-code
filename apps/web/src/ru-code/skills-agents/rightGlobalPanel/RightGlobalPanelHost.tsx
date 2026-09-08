// ru-code: the global overlay-panel host. Mounted once in AppSidebarLayout (so it persists
// across routes and is never thread-scoped), it docks the active global panel to the right
// slot. Desktop → an inline right column that PUSHES/shrinks the chat: it is a flex sibling of
// the routed content inside the SidebarProvider row (mirroring the port's own PreviewPanelShell,
// `shrink-0 border-l` + a left-edge resize handle), NOT a fixed overlay. Mobile/narrow → a sheet
// with a dismiss backdrop. While a global panel is open the thread panel is hidden (ChatView
// gates on the store), so the two never fight over the right slot — the ru-code overlay
// coordinator, ported to port's layout.

import type { ReactNode } from "react";

import { useExtendedViewPanelBinding } from "~/ru-code/extended-chat/extendedViewPanelBinding";
import { useActiveComposerTargetSync } from "~/ru-code/composer/activeComposerTarget";

import { RightPanelResizeHandle } from "~/components/preview/RightPanelResizeHandle";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";

import { pluginIdFromPanelId, PluginPanelSlotBoundary } from "~/ru-code/plugins/renderSafety";

import { useOverlayPanels, type OverlayPanel } from "./registry";
import { useRightGlobalPanelStore } from "./store";

// ru-code: desktop push-sidebar sizing (mirrors PreviewPanelShell). Width persists per browser
// and the panel is user-resizable via its left edge; the chat column shrinks to make room.
const PANEL_WIDTH_STORAGE_KEY = "ru-code:right-global-panel:width";
const PANEL_DEFAULT_WIDTH = 448;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 640;
// ru-code (A16, SDK 0.2.0): the ceiling a panel's OWN `preferredWidth` may reach.
//
// Separate from `PANEL_MAX_WIDTH` on purpose. Raising the shared 640 was the other way to fit
// `qwen-cli-analytics`'s six-column board (phase-2 plan §2.7, owner decision O3) and it would have
// changed the drag range of every panel in the app for the sake of one. This ceiling applies only
// to a panel that asked, and 960 is where a `lg:grid-cols-4` board stops gaining columns.
const PANEL_PREFERRED_MAX_WIDTH = 960;

/**
 * The docked width a panel ASKED for, clamped — or `null` when it asked for nothing usable.
 *
 * `Number.isFinite` and not `typeof === "number"`: the value crosses the plugin boundary, and
 * `NaN`/`±Infinity` are numbers. A `NaN` here would reach `useResizableWidth`'s `defaultWidth`,
 * where `clamp` returns `defaultWidth` for a non-finite input — i.e. `NaN` again — and the panel
 * would render `style={{ width: "NaNpx" }}`, which the browser drops, collapsing the column to its
 * flex minimum. Exported for its own test.
 */
export const preferredPanelWidth = (panel: OverlayPanel | null): number | null => {
  const value = panel?.preferredWidth;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_PREFERRED_MAX_WIDTH, value));
};

// ru-code: mobile sheet — a fixed right column paired with a dismiss backdrop (unchanged).
const SHEET_CLASS_NAME =
  "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-xl " +
  "w-[min(88vw,24rem)] " +
  "wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))]";

/**
 * The docked (desktop) panel column: the resize handle, the width, and the panel's body.
 *
 * Its own component so the width hook can be re-initialized per panel — see the mount site.
 */
function DockedGlobalPanel({
  panel,
  onClose,
}: {
  readonly panel: OverlayPanel;
  readonly onClose: () => void;
}) {
  const preferred = preferredPanelWidth(panel);
  const { width, handlers } = useResizableWidth({
    storageKey: PANEL_WIDTH_STORAGE_KEY,
    // The panel's request is a DEFAULT: `useResizableWidth` prefers the persisted value and falls
    // back to this only when the user has never dragged the edge.
    defaultWidth: preferred ?? PANEL_DEFAULT_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    // A panel that asked for more than the shared ceiling must be able to REACH it: the hook
    // clamps its own default to `maxWidth`, so leaving 640 here would silently discard the request
    // and would also stop the user dragging back out to it after narrowing the panel once.
    maxWidth: Math.max(PANEL_MAX_WIDTH, preferred ?? 0),
    edge: "left",
  });

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 shrink-0 flex-col self-stretch border-l border-border bg-card"
      style={{ width: `${width}px` }}
    >
      <RightPanelResizeHandle handlers={handlers} />
      {panel.render("sidebar", onClose)}
    </div>
  );
}

export function RightGlobalPanelHost() {
  const open = useRightGlobalPanelStore((state) => state.open);
  const close = useRightGlobalPanelStore((state) => state.close);
  const isSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // ru-code (sync wave R3): the extended view's per-thread detail target ⇄ this store. It
  // lives here because this host is mounted ONCE, above the routes, and outlives every thread
  // — the binding must keep running while the panel is closed (that is when it opens it).
  useExtendedViewPanelBinding();
  // ru-code: the route-following active composer target, mirrored into a store so callers
  // OUTSIDE React can read it — a plugin's `host.composer.attach(card)` is an imperative
  // call from the plugin's own click handler, not a render. Installed here for the same
  // reason `useExtendedViewPanelBinding` is: this host is mounted once, above the routes,
  // and outlives every thread.
  useActiveComposerTargetSync();

  // ru-code: reactive — plugins load AFTER the first render (A4 H2/M2), so a panel that
  // registers later must still be mountable by an id the store already holds.
  const panels = useOverlayPanels();
  const active = open === null ? null : (panels.find((panel) => panel.id === open) ?? null);

  // ru-code (A13 round 2, A12 finding R2-H1): the slot boundary is mounted UNCONDITIONALLY and
  // renders `null` while no panel is open — it must OUTLIVE the panel it protects. A plugin's
  // `useEffect` cleanup runs during the commit that removes its subtree, so a boundary inside the
  // panel is being destroyed in that same commit and React walks past it to the router root (the
  // crash card, with no attribution). See `plugins/renderSafety.tsx`'s header. It costs no DOM: a
  // boundary with `null` children renders nothing, which is what this host did before.
  let content: ReactNode = null;
  if (active !== null) {
    content = isSheet ? (
      // ru-code: mode "sheet" — floating overlay + dismiss backdrop for narrow viewports.
      <>
        <button
          type="button"
          aria-label="Close panel"
          className="fixed inset-0 z-40 bg-black/30"
          onClick={close}
        />
        <div className={SHEET_CLASS_NAME}>{active.render("sheet", close)}</div>
      </>
    ) : (
      // ru-code: mode "sidebar" — inline flex sibling that pushes/shrinks the chat column.
      //
      // KEYED BY PANEL ID (A16). The width hook reads localStorage in its state initializer, so a
      // `defaultWidth` that changes on a later render is never observed. Remounting per panel is
      // what makes a panel's own `preferredWidth` its default while leaving the persisted user
      // width — which the same initializer prefers — untouched and still winning.
      <DockedGlobalPanel key={active.id} panel={active} onClose={close} />
    );
  }

  return (
    <PluginPanelSlotBoundary onPluginFault={close} pluginId={pluginIdFromPanelId(open)}>
      {content}
    </PluginPanelSlotBoundary>
  );
}
