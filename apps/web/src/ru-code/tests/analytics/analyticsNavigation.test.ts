// ru-code: the analytics entry is a top-level page reached from the sidebar's bottom bar, NOT a
// settings section (owner decision row 4). Two host-side seams no build step checks semantically:
// the bar must recognise the page so it offers Back — a whole-area page whose bar still shows the
// icon row leaves no way back to the threads — and the settings list must stay out of it.
import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "../../../components/settings/SettingsSidebarNav";
import { resolveSidebarFooterPage } from "../../sidebar/footerPage";

describe("analytics navigation seam", () => {
  it("the sidebar bottom bar recognises the analytics page, so it offers Back", () => {
    expect(resolveSidebarFooterPage("/analytics")).toBe("analytics");
  });

  it("leaves the sibling whole-area pages alone", () => {
    expect(resolveSidebarFooterPage("/usage")).toBe("usage");
    expect(resolveSidebarFooterPage("/pull-requests")).toBe("pull-requests");
    expect(resolveSidebarFooterPage("/")).toBeNull();
  });

  it("keeps analytics out of the settings section list", () => {
    // ru-code: `SettingsPath` has no `/settings/analytics` member under this ruling (nothing ever
    // adds one), so the comparison is against the widened type — that absence is exactly the
    // fact being pinned.
    expect(SETTINGS_NAV_ITEMS.some((item) => (item.to as string) === "/settings/analytics")).toBe(
      false,
    );
  });
});
