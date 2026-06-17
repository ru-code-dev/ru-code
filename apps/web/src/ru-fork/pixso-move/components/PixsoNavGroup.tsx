import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { OVERLAY_PANELS, useRightPanelStore } from "~/ru-fork/rightPanel";

/**
 * Left-nav block (under search, above the projects list): one button per global
 * overlay panel (from OVERLAY_PANELS). Each toggles its right panel (click again to
 * close) and is highlighted while open; the coordinator keeps only one open at a time.
 */
export function PixsoNavGroup() {
  const openPanel = useRightPanelStore((state) => state.open);
  const toggle = useRightPanelStore((state) => state.toggle);

  return (
    <SidebarGroup className="px-2 pt-1 pb-0">
      <SidebarMenu>
        {OVERLAY_PANELS.map((panel) => {
          const Icon = panel.icon;
          return (
            <SidebarMenuItem key={panel.id}>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5"
                isActive={openPanel === panel.id}
                onClick={() => toggle(panel.id)}
                data-testid={`overlay-nav-${panel.id}`}
              >
                <Icon className="size-3.5" />
                <span className="flex-1 truncate text-left text-xs">{panel.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
