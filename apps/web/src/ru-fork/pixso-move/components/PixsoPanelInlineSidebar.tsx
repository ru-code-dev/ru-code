import type { CSSProperties } from "react";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { PixsoPanel } from "./PixsoPanel";

const PIXSO_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_pixso_sidebar_width";
const PIXSO_INLINE_DEFAULT_WIDTH = "clamp(24rem,32vw,34rem)";
const PIXSO_INLINE_SIDEBAR_MIN_WIDTH = 22 * 16;
const PIXSO_INLINE_SIDEBAR_MAX_WIDTH = 40 * 16;

/**
 * Desktop inline right-sidebar host for the Pixso panel. Mirrors the MCP / diff inline
 * sidebars so they share the same slot and resize/offcanvas behaviour.
 */
export function PixsoPanelInlineSidebar({
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
      style={{ "--sidebar-width": PIXSO_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth: PIXSO_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: PIXSO_INLINE_SIDEBAR_MIN_WIDTH,
          storageKey: PIXSO_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {open ? <PixsoPanel onClose={onClose} /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
