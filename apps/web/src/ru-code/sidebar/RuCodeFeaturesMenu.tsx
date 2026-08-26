// ru-code: the fork's SINGLE footer seam. Everything ru-code adds to t3's <SidebarFooter> lives
// here, so SidebarChrome.tsx carries one marked line instead of a growing block. Order inside the
// footer block: the auto-update pill (patch 12), then the feature rows (patch 13).
import { SidebarMenu } from "~/components/ui/sidebar";

import { SidebarAutoUpdatePill } from "../auto-update-ui/notify/SidebarAutoUpdatePill";
import { GlobalPanelNav } from "../skills-agents/rightGlobalPanel";

// ru-code: owner decision — every panel trigger lives in the footer icon rows now
// (SidebarChrome). The text-menu variant is KEPT, gated off, for later reuse.
const PANEL_TEXT_MENU_ENABLED = false;

export function RuCodeFeaturesMenu() {
  return (
    <>
      {/* ru-code: auto-update availability pill — folded in from SidebarChrome's footer. */}
      <SidebarAutoUpdatePill />
      {/* ru-code: text-menu panel nav — gated off (see PANEL_TEXT_MENU_ENABLED), not deleted. */}
      {PANEL_TEXT_MENU_ENABLED && (
        <SidebarMenu>
          <GlobalPanelNav />
        </SidebarMenu>
      )}
    </>
  );
}
