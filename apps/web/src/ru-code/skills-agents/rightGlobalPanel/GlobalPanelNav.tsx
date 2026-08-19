// ru-code: the sidebar nav buttons that toggle the global panels (Навыки / Агенты). One button
// per registry entry; the open panel is highlighted; clicking the open one closes it.

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

import { OVERLAY_PANELS } from "./registry";
import { useRightGlobalPanelStore } from "./store";

// ru-code: selected treatment identical to a highlighted project thread row — the `isActive`-only
// branch of resolveThreadRowClassName (Sidebar.logic.ts). This sidebar styles selection with explicit
// classes, NOT the SidebarMenuButton `data-[active=true]` variant, so we match it exactly.
const SELECTED_CLASS_NAME =
  "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70";
const IDLE_CLASS_NAME = "text-muted-foreground/70 hover:bg-accent hover:text-foreground";

export function GlobalPanelNav() {
  const open = useRightGlobalPanelStore((state) => state.open);
  const toggle = useRightGlobalPanelStore((state) => state.toggle);
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <>
      {OVERLAY_PANELS.map((panel) => {
        const Icon = panel.icon;
        const active = open === panel.id;
        return (
          <SidebarMenuItem key={panel.id}>
            <SidebarMenuButton
              size="sm"
              isActive={active}
              className={cn("gap-2 px-2 py-1.5", active ? SELECTED_CLASS_NAME : IDLE_CLASS_NAME)}
              onClick={() => {
                if (isMobile) {
                  setOpenMobile(false);
                }
                toggle(panel.id);
              }}
            >
              <Icon className="size-3.5" />
              <span className="text-xs">{panel.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
