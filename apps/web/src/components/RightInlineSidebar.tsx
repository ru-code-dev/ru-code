import type { CSSProperties, ReactNode } from "react";

import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

// ru-fork: single generic shell for the right-side inline sidebars (diff + overlays).
// Replaces three byte-identical wrappers — callers differ only in width constants,
// the storage key, an optional shouldAcceptWidth guard, and the (already open-gated)
// children they render.
export function RightInlineSidebar({
  open,
  onOpenChange,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  shouldAcceptWidth,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storageKey: string;
  defaultWidth: string;
  minWidth: number;
  maxWidth: number;
  shouldAcceptWidth?: (args: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="min-h-0 w-auto flex-none bg-transparent"
      style={{ "--sidebar-width": defaultWidth } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          maxWidth,
          minWidth,
          ...(shouldAcceptWidth ? { shouldAcceptWidth } : {}),
          storageKey,
        }}
      >
        {children}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
