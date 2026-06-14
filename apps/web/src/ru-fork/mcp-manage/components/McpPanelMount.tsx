// ru-fork: the single mount point for the MCP panel, hoisted into the shared
// `_chat` layout so it lives OUTSIDE any per-route component. This is what stops
// the panel remounting/jumping when navigating draft → thread (and makes it
// available on draft routes too). State is global (useMcpManagerStore), so it
// survives navigation; the panel chooses its responsive form here — a desktop
// inline right-sidebar or a mobile sheet — mirroring the diff panel.

import { useCallback } from "react";

import { RightPanelSheet } from "~/components/RightPanelSheet";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { useMcpManagerStore } from "../store";
import { McpPanel } from "./McpPanel";
import { McpPanelInlineSidebar } from "./McpPanelInlineSidebar";

export function McpPanelMount() {
  const open = useMcpManagerStore((state) => state.panelOpen);
  const setPanelOpen = useMcpManagerStore((state) => state.setPanelOpen);
  const close = useCallback(() => setPanelOpen(false), [setPanelOpen]);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

  if (useSheet) {
    return (
      <RightPanelSheet open={open} onClose={close}>
        <McpPanel onClose={close} />
      </RightPanelSheet>
    );
  }
  return <McpPanelInlineSidebar open={open} onClose={close} />;
}
