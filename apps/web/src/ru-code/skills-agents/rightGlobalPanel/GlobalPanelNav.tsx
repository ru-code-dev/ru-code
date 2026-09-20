// ru-code: the sidebar nav buttons that toggle the GLOBAL panels. One button per registry entry;
// the open panel is highlighted; clicking the open one closes it.
//
// Which panels those are is not this file's business and has changed twice: the fork's own
// skills/agents left with A25, and since V2-27 a plugin chooses per panel (`Panel.mount`) — the
// catalogs plugin now puts «Команды» here and «Навыки» / «Агенты» in the thread's right panel as
// tabs, so the entry for a TAB comes from the plugins folder instead (`plugins/slots.tsx`
// `usePluginNavEntries`).

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";

import { useNavPanels } from "./registry";
import { useRightGlobalPanelStore } from "./store";

export function GlobalPanelNav() {
  const open = useRightGlobalPanelStore((state) => state.open);
  const toggle = useRightGlobalPanelStore((state) => state.toggle);
  const { isMobile, setOpenMobile } = useSidebar();
  // ru-code: reactive — plugins load AFTER the first render now (A4 H2/M2), so a plugin's
  // nav entry has to appear when it registers, not only if it beat `createRoot`.
  const panels = useNavPanels();

  return (
    <>
      {/* ru-code: S44 — the ONE entry this menu still named left with its port, and the menu is
          gated off anyway (`RuCodeFeaturesMenu` · PANEL_TEXT_MENU_ENABLED). It renders every nav
          panel now rather than naming one, so whatever this build ships appears here if the gate
          is ever opened. */}
      {panels.map((panel) => {
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
