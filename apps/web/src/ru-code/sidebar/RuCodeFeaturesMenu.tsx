// ru-code: the fork's SINGLE footer seam. Everything ru-code adds to t3's <SidebarFooter> lives
// here, so SidebarChrome.tsx carries one marked line instead of a growing block. Order inside the
// footer block: the auto-update pill (patch 12), then the feature rows (patch 13).
import { SidebarMenu } from "~/components/ui/sidebar";

import { SidebarAutoUpdatePill } from "../auto-update-ui/notify/SidebarAutoUpdatePill";
import { GlobalPanelNav } from "../skills-agents/rightGlobalPanel";

export function RuCodeFeaturesMenu() {
  return (
    <>
      {/* ru-code: auto-update availability pill — folded in from SidebarChrome's footer. */}
      <SidebarAutoUpdatePill />
      {/* ru-code: skills/agents/commands/MCP nav — moved here from the sidebar body for
          persistent visibility. All four rows stay visible; GlobalPanelNav renders them with
          t3's own SidebarMenuButton at its default size (no fork styling). */}
      <SidebarMenu>
        <GlobalPanelNav />
      </SidebarMenu>
    </>
  );
}
