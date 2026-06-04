import type { CSSProperties } from "react";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { McpPanel } from "./McpPanel";

const MCP_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_mcp_sidebar_width";
const MCP_INLINE_DEFAULT_WIDTH = "clamp(24rem,32vw,34rem)";
const MCP_INLINE_SIDEBAR_MIN_WIDTH = 22 * 16;
const MCP_INLINE_SIDEBAR_MAX_WIDTH = 40 * 16;

/**
 * Desktop inline right-sidebar host for the MCP panel. Mirrors the diff panel's inline
 * sidebar so the two share the same slot and resize/offcanvas behaviour, only one open at a
 * time (mutual exclusion is enforced by the caller).
 */
export function McpPanelInlineSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="min-h-0 w-auto flex-none bg-transparent"
      style={{ "--sidebar-width": MCP_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: MCP_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: MCP_INLINE_SIDEBAR_MIN_WIDTH,
          storageKey: MCP_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {open ? <McpPanel onClose={onClose} /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
