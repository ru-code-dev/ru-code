// ru-code (A19): the surviving half of the deleted analyticsNavigation.test.ts. Analytics is a
// dropped-in plugin PANEL now, so `/analytics` is gone from the app entirely — but the seam the
// old suite guarded is still live: the sidebar's bottom bar must recognise a whole-area page so it
// offers Back (a whole-area page whose bar still shows the icon row leaves no way back to the
// threads). The sibling pages keep that behaviour and nothing else may claim it.
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarFooterPage } from "../../sidebar/footerPage";

describe("sidebar footer page", () => {
  it("recognises the whole-area pages, so the bar offers Back", () => {
    expect(resolveSidebarFooterPage("/usage")).toBe("usage");
    expect(resolveSidebarFooterPage("/pull-requests")).toBe("pull-requests");
  });

  it("returns null for the thread area", () => {
    expect(resolveSidebarFooterPage("/")).toBeNull();
  });

  it("no longer recognises /analytics — the page was removed with the compiled-in wiring", () => {
    expect(resolveSidebarFooterPage("/analytics")).toBeNull();
  });
});
