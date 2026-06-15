import { LayersIcon, ServerIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { usePixsoStore } from "../store";

/**
 * Left-nav block (under search, above the projects list): "Макеты Pixso" opens the right
 * panel; "MCP Серверы" is an inert placeholder for now (does nothing).
 */
export function PixsoNavGroup() {
  const openPanel = usePixsoStore((state) => state.openPanel);

  return (
    <SidebarGroup className="px-2 pt-1 pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5"
            onClick={openPanel}
            data-testid="pixso-move-nav"
          >
            <LayersIcon className="size-3.5" />
            <span className="flex-1 truncate text-left text-xs">Макеты Pixso</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="sm" className="gap-2 px-2 py-1.5 text-muted-foreground/70">
            <ServerIcon className="size-3.5" />
            <span className="flex-1 truncate text-left text-xs">MCP Серверы</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
