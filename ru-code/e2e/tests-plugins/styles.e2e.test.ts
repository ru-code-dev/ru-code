// ru-code (A18-fix) — spec 8: a plugin's stylesheet cannot restyle the app.
//
// WHAT WENT WRONG, exactly once and very loudly. `loadPlugins` used to `document.head.appendChild`
// the plugin's `<link>`, i.e. AFTER the app's own stylesheet. A plugin sheet is a global `<link>`
// in the app's document — nothing scopes it to the plugin's markup — so the analytics plugin's
// Tailwind `.hidden{display:none}` and the app's `@media(width>=48rem){.md\:block{display:block}}`
// were a same-specificity fight decided by SOURCE ORDER, and appending handed every one of those
// fights to the plugin. A18 measured it in a real browser: `[data-slot="sidebar"]` computed
// `display:none`, the sidebar and the entire footer nav disappeared, and with them the button that
// opens the plugin's own panel. The plugin had broken the HOST.
//
// The fixture is A18's `71-H2-css-leak.txt` rules in the SHAPE the analytics sheet had: inside
// `@layer utilities`, the same layer name the app's own Tailwind uses. That is what makes this a
// test of the HOST's half of the fix rather than of the SDK's: inside one shared layer the only
// tie-breaker is source order, so the sheet going first is the entire difference. (A plugin that
// ships UNLAYERED CSS beats the app's layered utilities whatever the order — no host can fix
// that, which is why "prefix your selectors" is still the rule for hand-written plugin CSS.)
//
// Like `renderFaults.e2e.test.ts`, the fixture is installed with a server restart and removed with
// another: the host scans the plugins directory once per process, and every other spec in this
// suite counts manifests, statuses and footer icons.
import {
  DEMO_CSS_ID,
  installCssLeakPlugin,
  restartPluginsApp,
  stopPluginsApp,
  removePluginFolder,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

import { demoFooterButton, expect, openAppWithDemo, state, test } from "./fixtures.ts";

/** What the app's own chrome is: the sidebar, and the footer nav inside it. */
const SIDEBAR = '[data-slot="sidebar"]';
const SIDEBAR_CONTAINER = '[data-slot="sidebar-container"]';
const SIDEBAR_FOOTER = '[data-slot="sidebar-footer"]';

test.describe("plugins — a plugin stylesheet never wins a fight with the app's own chrome", () => {
  // Two full server restarts inside one spec; the default 120 s covers neither.
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    installCssLeakPlugin(current.pluginsDir);
    await restartPluginsApp(current);
  });

  test.afterAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    removePluginFolder(current.pluginsDir, DEMO_CSS_ID);
    await restartPluginsApp(current);
  });

  test("the sidebar and the footer nav survive a plugin that ships bare display utilities", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await openAppWithDemo(page);

    // ── the sheet really is loaded, and really is FIRST ────────────────────────────────────────
    //
    // Both halves matter. A sheet that never loaded would make every assertion below pass for the
    // wrong reason, and the ORDER is the fix itself.
    const sheets = await page.evaluate(() => {
      const nodes = [...document.head.querySelectorAll('link[rel="stylesheet"], style')];
      return nodes.map((node, index) => ({
        index,
        tag: node.tagName.toLowerCase(),
        href: node.getAttribute("href"),
        isPlugin: node.hasAttribute("data-ru-code-plugin-styles"),
      }));
    });
    const pluginSheet = sheets.find((sheet) => sheet.href?.includes(`/plugins/${DEMO_CSS_ID}/`));
    // The app's OWN BUILT sheet — the `<link>` that carries its Tailwind utilities, which is the
    // sheet the plugin used to beat. Deliberately not "the first non-plugin node in head": React
    // hoists a `data-precedence` `<style>` (base-ui's scrollbar rule) to `head[0]` once a base-ui
    // popup has mounted, and where React puts React's own style is not the loader's business.
    const appSheet = sheets.find((sheet) => !sheet.isPlugin && sheet.tag === "link");
    expect(pluginSheet, "the plugin's stylesheet is in the document").toBeDefined();
    expect(pluginSheet?.isPlugin, "and it carries the loader's marker").toBe(true);
    expect(appSheet, "the app has a built stylesheet of its own").toBeDefined();
    expect(
      pluginSheet?.index,
      "the plugin sheet must precede the app's — that is the whole fix",
    ).toBeLessThan(appSheet?.index ?? -1);

    // ── the app's chrome is still there ────────────────────────────────────────────────────────
    //
    // BEFORE: `sidebarDisplay "none"`, `containerDisplay "none"`, and the plugin's own footer
    // button measured 0×0 (A18 evidence `70`/`71`, screenshot `20-sidebar-broken-by-plugin-css`).
    const chrome = await page.evaluate(
      ([sidebarSelector, containerSelector]: readonly string[]) => {
        const sidebar = document.querySelector(sidebarSelector ?? "");
        const container = document.querySelector(containerSelector ?? "");
        return {
          sidebar: sidebar === null ? null : getComputedStyle(sidebar).display,
          container: container === null ? null : getComputedStyle(container).display,
        };
      },
      [SIDEBAR, SIDEBAR_CONTAINER] as const,
    );
    expect(chrome.sidebar, "the app's sidebar must not be display:none").toBe("block");
    expect(chrome.container, "…nor its container").toBe("flex");

    await expect(page.locator(SIDEBAR_FOOTER).first()).toBeVisible({ timeout: 30_000 });
    // The footer nav is reachable, including the demo plugin's own button — the thing the defect
    // made unreachable.
    await expect(page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(demoFooterButton(page), "the plugin's own footer button is clickable").toBeVisible(
      {
        timeout: 30_000,
      },
    );
    const iconBox = await demoFooterButton(page).boundingBox();
    expect(iconBox?.width ?? 0, "…and has real size, not 0×0").toBeGreaterThan(0);
    expect(iconBox?.height ?? 0).toBeGreaterThan(0);

    // ── and the plugin's OWN rules still work ──────────────────────────────────────────────────
    //
    // Going first must not mean going unheard: on a class the app does not define, the plugin's
    // sheet is still the only sheet with an opinion.
    const probeColor = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "ru-demo-css-probe";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(probeColor, "the plugin's own rule still applies").toBe("rgb(1, 2, 3)");

    // ── the negative control: put the sheet back where it used to go ──────────────────────────
    //
    // Without this, a fixture that had simply stopped colliding would pass the assertions above
    // and prove nothing. Moving the plugin's `<link>` back AFTER the app's — the old
    // `appendChild` — must bring the defect back, which is what says the ordering is the cause.
    const sidebarDisplay = (): Promise<string | null> =>
      page.evaluate(() => {
        const sidebar = document.querySelector('[data-slot="sidebar"]');
        return sidebar === null ? null : getComputedStyle(sidebar).display;
      });

    // The SAME rules, re-applied at the END of `<head>` — the position `appendChild` used to give
    // them. Re-inserted as a `<style>` carrying the sheet's own text rather than by moving the
    // `<link>`: a moved link keeps its stylesheet's place in the CSSOM in Chromium, which would
    // make this control silently vacuous.
    const appended = await page.evaluate(async (id: string) => {
      // BY HREF: the demo plugin ships a stylesheet too, and it carries the same marker.
      const link = document.head.querySelector(
        `link[data-ru-code-plugin-styles][href*="/plugins/${id}/"]`,
      );
      const href = link?.getAttribute("href");
      if (href === null || href === undefined) return false;
      const css = await fetch(href).then(async (response) => await response.text());
      const style = document.createElement("style");
      style.id = "a18-css-leak-control";
      style.textContent = css;
      document.head.appendChild(style);
      return true;
    }, DEMO_CSS_ID);
    expect(appended, "the plugin's sheet could be read back and re-applied").toBe(true);
    await page.waitForTimeout(500);
    const broken = await sidebarDisplay();
    expect(
      broken,
      "the same rules applied AFTER the app's sheet must reproduce the defect — otherwise this " +
        "fixture proves nothing and the assertions above are vacuous",
    ).toBe("none");
    await saveEvidenceScreenshot(page, "71-sidebar-broken-by-appending-the-plugin-sheet");

    // …and removing it restores the app in the same page, with no reload.
    await page.evaluate(() => document.getElementById("a18-css-leak-control")?.remove());
    await page.waitForTimeout(500);
    const restored = await sidebarDisplay();
    expect(restored, "and removing it restores the app").toBe("block");

    await saveEvidenceScreenshot(page, "70-sidebar-with-css-leak-plugin");
    await saveEvidenceJson("70-css-leak", {
      sheets,
      chrome,
      probeColor,
      sidebarWhenAppended: broken,
      sidebarWhenPrepended: restored,
      consoleErrors,
      pageErrors,
    });

    expect(pageErrors, "no page errors").toEqual([]);
  });
});
