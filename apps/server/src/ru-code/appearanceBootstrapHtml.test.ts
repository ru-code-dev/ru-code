import { describe, expect, it } from "vite-plus/test";

import { injectAppearanceBootstrap } from "./appearanceBootstrapHtml.ts";
import { setBootstrapAppearance } from "./clientBootstrapState.ts";

const APPEARANCE = {
  themePreference: "aurora",
  appearanceMode: "dark" as const,
  followSystem: false,
  themeHalves: '{"light":"a","dark":"b"}',
  customThemes: '[{"id":"mine"}]',
};

describe("injectAppearanceBootstrap", () => {
  it("stamps all five appearance globals as an early child of <head>", () => {
    setBootstrapAppearance(APPEARANCE);
    const html = injectAppearanceBootstrap("<html><head><title>x</title></head></html>");

    expect(html).toContain('window.__RU_THEME_PREFERENCE__="aurora"');
    expect(html).toContain('window.__RU_THEME_APPEARANCE_MODE__="dark"');
    // booleans travel as strings — t3's pre-paint compares against "true"/"false"
    expect(html).toContain('window.__RU_THEME_FOLLOW_SYSTEM__="false"');
    expect(html).toContain("window.__RU_THEME_HALVES__=");
    expect(html).toContain("window.__RU_CUSTOM_THEMES__=");
    // must land before any other head content so the pre-paint can read it
    expect(html.indexOf("__RU_THEME_PREFERENCE__")).toBeLessThan(html.indexOf("<title>"));
  });

  it("escapes payloads so a crafted theme cannot break out of the script", () => {
    setBootstrapAppearance({ ...APPEARANCE, customThemes: '[{"id":"</script>"}]' });
    const html = injectAppearanceBootstrap("<html><head></head></html>");
    expect(html).not.toContain('"</script>"');
  });

  it("is a no-op when there is no <head>", () => {
    setBootstrapAppearance(APPEARANCE);
    expect(injectAppearanceBootstrap("<html></html>")).toBe("<html></html>");
  });
});
