// ru-code: the sidebar nav buttons that toggle the global panels (Навыки / Агенты). One button
// per registry entry; the open panel is highlighted; clicking the open one closes it.

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";

import { NAV_PANELS } from "./registry";
import { useRightGlobalPanelStore } from "./store";

export function GlobalPanelNav() {
  const open = useRightGlobalPanelStore((state) => state.open);
  const toggle = useRightGlobalPanelStore((state) => state.toggle);
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <>
      {/* ru-code: only Pixso lives in the text menu — skills/agents/commands/mcp moved to the
          footer icon row (SidebarChromeFooter). */}
      {NAV_PANELS.filter((panel) => panel.id === "pixso").map((panel) => {
        const Icon = panel.icon;
        const active = open === panel.id;
        return (
          <SidebarMenuItem key={panel.id}>
            <SidebarMenuButton
              isActive={active}
              onClick={() => {
                if (isMobile) {
                  setOpenMobile(false);
                }
                toggle(panel.id);
              }}
            >
              <Icon />
              <span>{panel.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
