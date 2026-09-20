// ru-code v2 — the PAGE seam (decision V2-4), which v1 did not have at all.
//
// WHY IT EXISTS. v1 gave a plugin one visual surface: a right-hand panel. Anything dashboard-shaped
// had to be squeezed into it — the analytics plugin asked the host for a 960 px panel and got a
// nine-widget board rendered as a single column — and the owner's verdict on that was "regression
// is unacceptable". v2 owns ONE route, `/plugins/$pluginId/$pageId`, and mounts the plugin's
// component inside the app's normal chrome.
//
// Four claims, each a different way the route could be wrong:
//
//  1. the plugin's `pages[].nav` puts a FOOTER BUTTON in the sidebar, and pressing it navigates;
//  2. the page renders inside the app's chrome — the sidebar is still there, so this is a page of
//     the app and not a takeover;
//  3. it is a real route: a DIRECT navigation to the URL (a cold load, no click) renders it. That
//     is the one that would fail if the route resolved plugins eagerly, because on a cold load the
//     plugins are imported AFTER the first paint;
//  4. the page is the same data as the panel — a note added on the page is on the panel — which is
//     what makes two surfaces of one plugin worth having.
import {
  addDemoNote,
  clearDemoNotes,
  closeDemoPanel,
  demoNoteBodies,
  demoPage,
  demoPageButton,
  demoPanel,
  demoStatus,
  expect,
  openAppWithDemo,
  openDemoPanel,
  state,
  test,
  waitForPluginConnection,
} from "./fixtures.ts";
import { DEMO_ID } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

/** The route the host owns. `notes` is `DEMO_PAGE_ID` in the plugin's own `pages` seam. */
const PAGE_PATH = `/plugins/${DEMO_ID}/notes`;
const NOTE = "page-spec note";

test.describe("plugins — a plugin PAGE on the host's own route", () => {
  test.setTimeout(180_000);

  test("the footer entry navigates to it, it renders inside the chrome, and a direct URL works", async ({
    page,
  }) => {
    const evidence: Record<string, unknown> = { spec: "page.e2e.test.ts", path: PAGE_PATH };

    await openAppWithDemo(page);

    // ── 1. the nav entry the plugin's `pages[].nav` asked for ─────────────────────────────────
    await expect(
      demoPageButton(page),
      "the plugin's page has a footer button of its own",
    ).toBeVisible({ timeout: 30_000 });
    // …and it is NOT the panel's button: two surfaces, two entries.
    await expect(page.getByRole("button", { name: /^(Демо|Demo)$/ })).toBeVisible();

    await demoPageButton(page).click();
    await expect(demoPage(page), "pressing it renders the plugin's page").toBeVisible({
      timeout: 30_000,
    });
    expect(new URL(page.url()).pathname, "on the host-owned route").toBe(PAGE_PATH);

    // ── 2. inside the app's normal chrome ─────────────────────────────────────────────────────
    await expect(
      page.locator('[data-slot="sidebar"]').first(),
      "the app's own sidebar is still there — a plugin page is a page, not a takeover",
    ).toBeVisible();
    // S22 (owner): a plugin page is a WHOLE-AREA page like `/usage`, so the sidebar's bottom bar
    // collapses to the same Back button there (`ru-code/sidebar/footerPage.ts` recognises the
    // host-owned route pattern; no plugin is involved). At baseline the compiled-in `/analytics`
    // page had it; its plugin successor must not lose it.
    const back = page.locator('[data-sidebar="footer"]').getByRole("button", {
      name: /^(Назад|Back)$/,
    });
    await expect(back, "the footer shows Back on a plugin page").toBeVisible({ timeout: 30_000 });

    // …including the app's BREADCRUMB, from `Page.title` + `PluginIcon(icon)` (V2-15, closing
    // analytics R2). Before this the plugin page was the one whole-area surface in the app with no
    // titlebar row at all, and no plugin could supply one without imitating app chrome.
    const crumb = page.locator('[data-slot="plugin-page-header"]');
    await expect(crumb, "the host renders a titlebar row for the page").toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="plugin-page-title"]')).toHaveText(
      /^(Демо-заметки|Demo notes)$/,
    );
    // The icon is the HOST's lucide, resolved from the name the seam gave — never plugin React.
    expect(await crumb.locator("svg").count(), "…with the page's own glyph beside it").toBe(1);
    // The breadcrumb is HOST markup and must sit OUTSIDE the plugin's CSS scope (V2-14), or a
    // plugin sheet could restyle the app's own chrome from inside a plugin folder.
    expect(
      await crumb.evaluate((node) => node.closest("[data-plugin-root]") !== null),
      "the app's chrome is not inside the plugin's stylesheet scope",
    ).toBe(false);
    evidence["breadcrumb"] = await crumb.innerText();
    await waitForPluginConnection(page);
    await saveEvidenceScreenshot(page, "11-page-from-nav");
    evidence["statusOnPage"] = await demoStatus(page).innerText();

    // The page's own surfaces work: it reads the same store the panel does.
    await clearDemoNotes(page);
    await addDemoNote(page, NOTE);
    expect(await demoNoteBodies(page), "the page round-trips a note of its own").toEqual([NOTE]);
    // `projects.count` reaches the app's read model through the plugin's SERVER half.
    await expect(page.locator('[data-testid="demo-projects"]')).toBeVisible({ timeout: 20_000 });
    evidence["projectsLine"] = await page.locator('[data-testid="demo-projects"]').innerText();
    await saveEvidenceScreenshot(page, "11-page-with-note");

    // ── 3. a DIRECT navigation, cold ──────────────────────────────────────────────────────────
    //
    // The plugins are imported after the first paint, so a route that resolved its page eagerly
    // would render "not installed" and stay there. This is the assertion that catches it.
    await page.goto(`${state().webUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(demoPage(page), "a cold load of the URL renders the page").toBeVisible({
      timeout: 30_000,
    });
    // …and Back leaves it, with its existing behaviour (`SidebarChrome.tsx` `handleBackClick`).
    await expect(back, "Back is there on a cold load too").toBeVisible({ timeout: 30_000 });
    await back.dispatchEvent("click", { timeout: 15_000 });
    await expect
      .poll(() => new URL(page.url()).pathname, {
        timeout: 30_000,
        message: "Back leaves the plugin page",
      })
      .not.toBe(PAGE_PATH);
    await expect(demoPage(page)).toHaveCount(0, { timeout: 30_000 });
    evidence["backLeavesTo"] = new URL(page.url()).pathname;
    await page.goto(`${state().webUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(demoPage(page)).toBeVisible({
      timeout: 30_000,
    });
    await waitForPluginConnection(page);
    await expect
      .poll(() => demoNoteBodies(page), {
        timeout: 30_000,
        message: "the note is still there after a cold load of the page URL",
      })
      .toEqual([NOTE]);

    // S5, step 6 (S4-docs §4.3). THIS is the load that used to fail: on a cold page load the
    // environment connection is still coming up when the surface mounts, `ProjectCount` fired
    // `projects.count` unconditionally in a mount effect, the call rejected, and — a mount effect
    // running once — the line read «Количество проектов недоступно» for the life of the page.
    // Gated on `ctx.connection === "ready"` like `DemoPanel`'s first `notes.list`, it now resolves.
    await expect
      .poll(async () => await page.locator('[data-testid="demo-projects"]').innerText(), {
        timeout: 30_000,
        intervals: [500],
        message: "the project count resolves on a COLD load, not just a warm one",
      })
      .toMatch(/\d/);
    evidence["projectsLineCold"] = await page.locator('[data-testid="demo-projects"]').innerText();
    await saveEvidenceScreenshot(page, "11-page-direct-url");

    // ── 4. the panel sees the same data ───────────────────────────────────────────────────────
    //
    // From the threads: since S22 a plugin page's footer is the Back button, so the demo's GLOBAL
    // panel icon is not on the rail here — Back first, which is how a user gets there too.
    await back.dispatchEvent("click", { timeout: 15_000 });
    await expect(demoPage(page)).toHaveCount(0, { timeout: 30_000 });
    await openDemoPanel(page);
    expect(await demoNoteBodies(page), "the panel shows what the page wrote").toContain(NOTE);
    await saveEvidenceScreenshot(page, "11-page-and-panel");

    // ── an unknown page id degrades, it does not crash ────────────────────────────────────────
    await closeDemoPanel(page);
    await page.goto(`${state().webUrl}/plugins/${DEMO_ID}/no-such-page`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator('[data-slot="plugin-page-missing"]'),
      "an unknown page id says so, inside the chrome",
    ).toBeVisible({ timeout: 30_000 });
    // …and it is still a plugin-page ROUTE, so the footer offers the way out (S22).
    await expect(back, "Back is offered on a missing page id too").toBeVisible({ timeout: 30_000 });

    saveEvidenceJson("11-page", evidence);

    // Leave the shared app the way the next spec expects to find it.
    await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await closeDemoPanel(page);
    await expect(demoPanel(page)).toBeHidden();
  });
});
