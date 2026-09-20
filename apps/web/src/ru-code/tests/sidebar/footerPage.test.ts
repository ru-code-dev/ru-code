// ru-code (A19, S22): the sidebar's bottom bar must recognise a whole-area page so it offers Back —
// a whole-area page whose bar still shows the icon row leaves no way back to the threads. The
// app's own two pages keep that behaviour, a PLUGIN page gets it too (S22, owner: at baseline the
// compiled-in `/analytics` page had the footer Back; its plugin successor must not lose it), and
// nothing else may claim it.
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarFooterPage } from "../../sidebar/footerPage";

describe("sidebar footer page", () => {
  it("recognises the whole-area pages, so the bar offers Back", () => {
    expect(resolveSidebarFooterPage("/usage")).toBe("usage");
    expect(resolveSidebarFooterPage("/pull-requests")).toBe("pull-requests");
  });

  it("recognises a plugin PAGE by the host-owned route pattern, naming no plugin (S22)", () => {
    expect(resolveSidebarFooterPage("/plugins/analytics/dashboard")).toBe("plugin-page");
    expect(resolveSidebarFooterPage("/plugins/demo/notes")).toBe("plugin-page");
    expect(resolveSidebarFooterPage("/plugins/demo/notes/")).toBe("plugin-page");
  });

  it("returns null for the thread area and for paths that only look like the plugin route", () => {
    expect(resolveSidebarFooterPage("/")).toBeNull();
    expect(resolveSidebarFooterPage("/plugins")).toBeNull();
    expect(resolveSidebarFooterPage("/plugins/demo")).toBeNull();
    expect(resolveSidebarFooterPage("/plugins/demo/notes/deeper")).toBeNull();
    expect(resolveSidebarFooterPage("/settings")).toBeNull();
  });

  it("no longer recognises /analytics — the page was removed with the compiled-in wiring", () => {
    expect(resolveSidebarFooterPage("/analytics")).toBeNull();
  });
});
