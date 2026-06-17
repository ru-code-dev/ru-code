import { useRef } from "react";

import { RightInlineSidebar } from "~/components/RightInlineSidebar";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { OVERLAY_PANELS, type OverlayPanel } from "./registry";
import { useRightPanelStore } from "./store";

/**
 * ru-fork: the single shared host for every global overlay panel. ONE slider (or
 * sheet) whose content is whichever registry entry is open — which is what makes the
 * transitions read well:
 *   - open → close keeps the active panel's content mounted through the slide-out, so
 *     the real panel (with its own background) slides away instead of an empty shell;
 *   - switching one overlay for another keeps the slot open and swaps content in place
 *     (no slide-out-then-slide-in);
 *   - width + remembered resize follow the active panel (each entry has its own
 *     storageKey); the sidebar re-reads that on swap and animates `--sidebar-width`.
 *
 * Visibility + N-way mutual exclusion come from useRightPanelStore.
 */
export function OverlayPanelHost() {
  const open = useRightPanelStore((state) => state.open);
  const close = useRightPanelStore((state) => state.close);
  const shouldUseSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

  // Remember the last opened panel so its content stays rendered while the slot
  // slides closed (`open` is null during the close transition).
  const lastShownRef = useRef<OverlayPanel | null>(open);
  if (open !== null) {
    lastShownRef.current = open;
  }

  const activeId = open ?? lastShownRef.current;
  const active = activeId === null ? null : OVERLAY_PANELS.find((panel) => panel.id === activeId);

  const isOpen = open !== null;
  const form = shouldUseSheet ? "sheet" : "sidebar";
  const content = active ? active.render(form, close) : null;
  // The host must stay mounted (collapsed) even before the first open, otherwise the
  // first open would mount the slider already-expanded and skip the slide-in (CSS
  // transitions only animate state changes, not initial mount). Width comes from the
  // active panel; before anything is opened it falls back to the first registry entry
  // (widths are uniform, and the slot is off-screen then anyway).
  const width = (active ?? OVERLAY_PANELS[0]).width;

  if (shouldUseSheet) {
    return (
      <RightPanelSheet open={isOpen} onClose={close}>
        {content}
      </RightPanelSheet>
    );
  }

  return (
    <RightInlineSidebar
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      storageKey={width.storageKey}
      defaultWidth={width.defaultWidth}
      minWidth={width.minWidth}
      maxWidth={width.maxWidth}
    >
      {content}
    </RightInlineSidebar>
  );
}

