// ru-code: the global overlay-panel host. Mounted once in AppSidebarLayout (so it persists
// across routes and is never thread-scoped), it docks the active global panel to the right
// slot. Desktop → an inline right column that PUSHES/shrinks the chat: it is a flex sibling of
// the routed content inside the SidebarProvider row (mirroring the port's own PreviewPanelShell,
// `shrink-0 border-l` + a left-edge resize handle), NOT a fixed overlay. Mobile/narrow → a sheet
// with a dismiss backdrop. While a global panel is open the thread panel is hidden (ChatView
// gates on the store), so the two never fight over the right slot — the ru-code overlay
// coordinator, ported to port's layout.

import { RightPanelResizeHandle } from "~/components/preview/RightPanelResizeHandle";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";

import { overlayPanelById } from "./registry";
import { useRightGlobalPanelStore } from "./store";

// ru-code: desktop push-sidebar sizing (mirrors PreviewPanelShell). Width persists per browser
// and the panel is user-resizable via its left edge; the chat column shrinks to make room.
const PANEL_WIDTH_STORAGE_KEY = "ru-code:right-global-panel:width";
const PANEL_DEFAULT_WIDTH = 448;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 640;

// ru-code: mobile sheet — a fixed right column paired with a dismiss backdrop (unchanged).
const SHEET_CLASS_NAME =
  "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-card shadow-xl " +
  "w-[min(88vw,24rem)] " +
  "wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))]";

export function RightGlobalPanelHost() {
  const open = useRightGlobalPanelStore((state) => state.open);
  const close = useRightGlobalPanelStore((state) => state.close);
  const isSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // ru-code: hooks run unconditionally (before the null-panel early return) to keep hook order
  // stable across renders regardless of which panel (if any) is open.
  const { width, handlers } = useResizableWidth({
    storageKey: PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: PANEL_DEFAULT_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    edge: "left",
  });

  const active = open === null ? null : overlayPanelById(open);
  if (active === null) {
    return null;
  }

  if (isSheet) {
    // ru-code: mode "sheet" — floating overlay + dismiss backdrop for narrow viewports.
    return (
      <>
        <button
          type="button"
          aria-label="Закрыть панель"
          className="fixed inset-0 z-40 bg-black/30"
          onClick={close}
        />
        <div className={SHEET_CLASS_NAME}>{active.render("sheet", close)}</div>
      </>
    );
  }

  // ru-code: mode "sidebar" — inline flex sibling that pushes/shrinks the chat column.
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 shrink-0 flex-col self-stretch border-l border-border bg-card"
      style={{ width: `${width}px` }}
    >
      <RightPanelResizeHandle handlers={handlers} />
      {active.render("sidebar", close)}
    </div>
  );
}
