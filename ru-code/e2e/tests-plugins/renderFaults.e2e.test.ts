// ru-code v2 — spec 8: plugin REACT that fails stays inside the plugin.
//
// The v1 audit's HIGH findings, as browser facts. Each of them was, at the time, a way for four
// lines of plugin code to take the whole application down:
//
//  · a panel `render` that throws — no boundary on the click path, so the app booted healthy and
//    became the crash card the moment the footer icon was pressed;
//  · a panel whose effect CLEANUP throws — it opens healthy and dies on CLOSE, because the cleanup
//    runs during the commit that REMOVES the subtree and every boundary inside it is being
//    destroyed in that same commit. React walked past them to the router root: the crash card
//    again, this time with no attribution at all;
//  · a body that SUSPENDS forever — a pure white viewport at boot, with no crash card, no toast,
//    no console line and no page error: undebuggable, and recoverable only from a shell;
//  · a `render` that returns a PENDING PROMISE — React 19 `use()`s a thenable child, so the click
//    that opened the panel blanked the viewport and CLOSING it did not bring the app back. v1
//    REFUSED this at the seam, which it could because its seam was a function the host called; v2's
//    seam is a `ComponentType`, so React calls it and the thenable never reaches host code. It is
//    contained the same way any other suspension is — a placeholder, the app intact, and the
//    plugin named when the budget runs out — which is what this spec now asserts;
//  · a contribution FLOOD — 300 malformed entries produced 600 reports, and the tab stopped
//    answering: `page.evaluate("1+1")` timed out at 20 s and even a screenshot could not be taken.
//
// WHAT v2 CHANGED IN THIS SPEC. The v1 audit's very first finding was a panel ICON that throws,
// which was rendered by the footer row on EVERY page load with no boundary above it. That fixture
// cannot be written any more: an icon is a lucide NAME (decision V2-6), so the host renders it with
// its own lucide and a plugin has no way to put a component there. What replaces it below is the
// name case — an icon this build has never heard of must degrade to a glyph, never to a hole and
// never to a throw. The rest are unchanged in spirit and re-pointed at the v2 surfaces.
//
// WHY IT INSTALLS AND RESTARTS. `PluginHost.start` scans once per process, so a plugin dropped in
// after the spawn does not exist for that process. Seeding these fixtures at globalSetup instead
// would change the expectations of the other specs (`isolation` counts console errors, `manifests`
// enumerates the folder) for this one spec's benefit. It therefore installs, restarts, asserts,
// removes and restarts again — leaving the harness exactly as it found it for
// `uninstall.e2e.test.ts`, which sorts after this file.
// @effect-diagnostics globalDate:off
import type { Locator } from "@playwright/test";

import {
  clearComposer,
  closeDemoPanel,
  commandMenu,
  demoFooterButton,
  expect,
  openAppWithDemo,
  state,
  test,
  typeTrigger,
} from "./fixtures.ts";
import {
  DEMO_FAULTY_ID,
  DEMO_FLOOD_ID,
  DEMO_SUSPEND_ID,
  installFaultyPlugin,
  installFloodPlugin,
  installSuspendPlugin,
  removePluginFolder,
  restartPluginsApp,
  stopPluginsApp,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const RENDER_PANEL = /^Boom render$/;
const UNMOUNT_PANEL = /^Boom unmount$/;
const BOOM_PAGE = /^Boom page$/;

/** The card `PluginSurface` degrades to, whichever seam produced the component. */
const FAILED_CARD = '[data-slot="plugin-surface-failed"]';
const PENDING_CARD = '[data-slot="plugin-surface-pending"]';

/** The suite's own click idiom (`fixtures.ts:toggleDemoPanel`): real click, bounded fallback. */
const clickOrDispatch = async (locator: Locator): Promise<void> => {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const clicked = await locator
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await locator.dispatchEvent("click");
};

test.describe("plugins — a page or panel that fails never reaches the host", () => {
  // Two full server restarts inside one spec; the default 120 s covers neither.
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    installFaultyPlugin(current.pluginsDir);
    // React that SUSPENDS and a contribution flood, each its own plugin so their reports cannot be
    // de-duplicated into one another's.
    installSuspendPlugin(current.pluginsDir);
    installFloodPlugin(current.pluginsDir);
    await restartPluginsApp(current);
  });

  test.afterAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    removePluginFolder(current.pluginsDir, DEMO_FAULTY_ID);
    removePluginFolder(current.pluginsDir, DEMO_SUSPEND_ID);
    removePluginFolder(current.pluginsDir, DEMO_FLOOD_ID);
    await restartPluginsApp(current);
  });

  test("the app boots, every failing surface degrades in place, and each is reported once", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    /**
     * Every `[plugins] <id> <code>: …` line the HOST wrote (V2-42).
     *
     * It is `console.debug` now, not `console.error`: a plugin's authoring mistake is not the app
     * failing, and it is never a toast either — the person who can act on it reads this line or the
     * plugin's row in the Plugins settings section.
     */
    const hostLines: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      const line = message.text();
      if (line.startsWith("[plugins] ")) hostLines.push(line);
      if (message.type() === "error") consoleErrors.push(line);
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // ── the app is INTERACTIVE with three broken plugins in the folder ─────────────────────────
    await openAppWithDemo(page);
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible({
      timeout: 30_000,
    });

    const renderButton = page.getByRole("button", { name: RENDER_PANEL });
    await expect(renderButton).toBeVisible({ timeout: 30_000 });

    // ── an icon NAME the host has never heard of degrades to a glyph ───────────────────────────
    //
    // This is what replaced v1's throwing-icon fixture. The nav entry is there, it has a real SVG
    // in it, and nothing was reported — an unknown name is a plugin built against a newer lucide,
    // not a fault.
    const boomPageButton = page.getByRole("button", { name: BOOM_PAGE });
    await expect(boomPageButton, "an unknown icon name still gets its button").toBeVisible({
      timeout: 30_000,
    });
    await expect(
      boomPageButton.locator("svg"),
      "…with the fallback glyph in it, not an empty box",
    ).toHaveCount(1);

    // The healthy plugin is untouched.
    await expect(demoFooterButton(page)).toBeVisible({ timeout: 30_000 });
    await saveEvidenceScreenshot(page, "08-app-with-faulty-plugin");

    // ── a panel whose render throws gives a fallback CARD, not the crash card ──────────────────
    await clickOrDispatch(renderButton);
    const fallbackCard = page.locator(FAILED_CARD);
    await expect(fallbackCard, "the panel body degrades in place").toBeVisible({ timeout: 20_000 });
    await expect(fallbackCard).toContainText(/Demo \(faulty\)/);
    await expect(fallbackCard).toContainText("panel render boom");
    // BEFORE: `rootChildren` collapsed from 78 684 to 4 930 and the composer was gone.
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app is still there behind the failed panel",
    ).toBeVisible();
    await saveEvidenceScreenshot(page, "08-panel-render-fallback");

    // A failed panel is not a trap: the footer icon still closes it.
    await clickOrDispatch(renderButton);
    await expect(fallbackCard).toBeHidden({ timeout: 20_000 });

    // ── a PAGE whose render throws degrades the same way, inside the app's chrome ──────────────
    //
    // v2 added the page route, so the page seam gets the same proof the panel seam has: the
    // sidebar is still there, the app is still navigable, and only the page's own area failed.
    await clickOrDispatch(boomPageButton);
    await expect(page.locator(FAILED_CARD), "the page body degrades in place").toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(FAILED_CARD)).toContainText("page render boom");
    // S22 (owner): a plugin page is a WHOLE-AREA page, so the sidebar's footer rail collapses to
    // the app's own Back there (`ru-code/sidebar/footerPage.ts`) — the demo's footer icon is behind
    // Back on a failed page exactly as on a healthy one (`page.e2e.test.ts` §2). The chrome being
    // intact is the sidebar and that Back: both HOST markup, outside the failed page's area.
    await expect(
      page.locator('[data-slot="sidebar"]').first(),
      "the app's own sidebar is intact around a failed plugin page",
    ).toBeVisible();
    await expect(
      page.locator('[data-sidebar="footer"]').getByRole("button", { name: /^(Назад|Back)$/ }),
      "…with the app's own Back in its footer, as on a healthy plugin page",
    ).toBeVisible();
    await saveEvidenceScreenshot(page, "08-page-render-fallback");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible({
      timeout: 30_000,
    });

    // ── a panel whose effect CLEANUP throws dies on CLOSE, and takes nothing with it ───────────
    //
    // BEFORE: open → «body», CLOSE → the whole viewport became the crash card, `#root` collapsed
    // from 80 679 to 4 906 characters, and there was NO attribution at all.
    const unmountButton = page.getByRole("button", { name: UNMOUNT_PANEL });
    await clickOrDispatch(unmountButton);
    const unmountBody = page.locator('[data-t="panelunmount"]');
    await expect(unmountBody, "the panel opens healthy — the fault is on the way OUT").toBeVisible({
      timeout: 20_000,
    });
    await saveEvidenceScreenshot(page, "08-panel-unmount-open");

    // Click the footer icon a second time: the most ordinary interaction there is.
    await clickOrDispatch(unmountButton);
    await expect(unmountBody, "the panel closed").toBeHidden({ timeout: 20_000 });
    // WHO CATCHES THIS ONE, in v2. A throw inside a `useEffect` CLEANUP is not delivered to an
    // error boundary at all — React 19 catches it at the root, logs it and carries on. So the
    // containment here is React's, not the host's, and the assertions below are the containment
    // itself: the app is intact, there is no crash card, and nothing escaped as a page error.
    //
    // S3 step G added the ATTRIBUTION back (S1 §7.5): `main.tsx` passes `onUncaughtError`, which
    // maps a stack carrying a `/plugins/<id>/` frame to that plugin and reports it through the
    // ordinary problem channel. Supplying that callback REPLACES React's own console output, so
    // the log assertion below is also the guard on the hook not silencing it.
    await expect
      .poll(() => consoleErrors.filter((text) => text.includes("panel unmount boom")).length, {
        timeout: 20_000,
        message: "the unmount throw is logged, with the plugin's own module in the stack",
      })
      .toBeGreaterThan(0);
    expect(
      consoleErrors.find((text) => text.includes("panel unmount boom")),
      "…and the stack names the plugin that threw",
    ).toContain(`/plugins/${DEMO_FAULTY_ID}/`);
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app survived the unmount throw",
    ).toBeVisible();
    // The crash card is the router's own error view; it must not be on screen.
    await expect(
      page.getByRole("heading", { name: /Something went wrong|Что-то пошло не так/ }),
    ).toBeHidden();
    await expect(demoFooterButton(page), "the healthy plugin is still there").toBeVisible();
    // …and the host NAMES the plugin now (S3 step G) — once, whatever React does afterwards.
    await expect
      .poll(
        () => hostLines.filter((text) => text.startsWith(`[plugins] ${DEMO_FAULTY_ID} `)).length,
        { timeout: 20_000, message: "the host attributes the unmount throw to the plugin" },
      )
      .toBeGreaterThan(0);
    await saveEvidenceScreenshot(page, "08-panel-unmount-closed");

    // ── a body that SUSPENDS forever ───────────────────────────────────────────────────────────
    //
    // BEFORE: a pure white 1440×900 viewport, `#root.innerHTML` 0 characters, and no crash card, no
    // toast, no console message and no page error to explain it.
    const suspendReports = () =>
      hostLines.filter((text) => text.startsWith(`[plugins] ${DEMO_SUSPEND_ID} `));
    const hangButton = page.getByRole("button", { name: /^Hang body$/ });
    await clickOrDispatch(hangButton);
    await expect(
      page.locator(`${PENDING_CARD}[data-plugin-id="${DEMO_SUSPEND_ID}"]`),
      "a placeholder stands in for a suspended body, and the app stays up",
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible();
    await saveEvidenceScreenshot(page, "08-suspended-body");
    // …and the diagnostic half: a surface still suspended when its 10 s budget runs out is NAMED,
    // once. React reports nothing itself, which is exactly why the blank page was undebuggable.
    await expect
      .poll(() => suspendReports().filter((text) => /panel:hang:/.test(text)).length, {
        timeout: 30_000,
        message: "the suspended body is named once its budget expires",
      })
      .toBe(1);
    await clickOrDispatch(hangButton);

    // The control resolves after 3 s: its panel shows the REAL content, which is what makes the
    // Suspense a containment rather than a refusal of `lazy`.
    const lateButton = page.getByRole("button", { name: /^Late body$/ });
    await clickOrDispatch(lateButton);
    await expect(page.locator('[data-t="latebody"]')).toBeVisible({ timeout: 30_000 });
    await clickOrDispatch(lateButton);

    // ── a render that returns a PENDING promise ────────────────────────────────────────────────
    //
    // BEFORE: clicking this footer icon blanked the viewport (composer gone, `#root` intact at
    // 80 167 characters because React hides suspended content with `display:none`), and CLOSING
    // the panel did not bring it back — only a reload did. React 19 `use()`s a thenable a component
    // returns, so under the v2 seam this IS a suspension and is contained as one.
    const promiseButton = page.getByRole("button", { name: /^Promise render$/ });
    await clickOrDispatch(promiseButton);
    await expect(
      page.locator(`${PENDING_CARD}[data-plugin-id="${DEMO_SUSPEND_ID}"]`),
      "a thenable body suspends into the placeholder instead of blanking the app",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app is still there behind the suspended panel",
    ).toBeVisible();
    await saveEvidenceScreenshot(page, "08-promise-render-suspended");
    await expect
      .poll(() => suspendReports().filter((text) => /panel:promise:/.test(text)).length, {
        timeout: 30_000,
        message: "the thenable body is named once its budget expires",
      })
      .toBe(1);
    // …and closing it leaves the app running, which is the half that never recovered before.
    await clickOrDispatch(promiseButton);
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Something went wrong|Что-то пошло не так/ }),
    ).toBeHidden();

    // ── the FLOOD: 1 304 panels and 1 300 composer rows from one plugin ────────────────────────
    //
    // BEFORE: 600 reports, and the tab stopped answering. The app being interactive here (every
    // assertion above ran against this same page) IS the fix.
    expect(await page.evaluate("1 + 1"), "the page still answers").toBe(2);
    // The composer seam only runs when a composer menu asks for rows, so open one: without this the
    // spec would assert the absence of a report it never gave the host a reason to produce.
    await clearComposer(page);
    await typeTrigger(page, "/");
    await expect(commandMenu(page)).toBeVisible({ timeout: 20_000 });
    await saveEvidenceScreenshot(page, "08-flood-menu");
    await clearComposer(page);

    const floodReports = hostLines.filter((text) => text.startsWith(`[plugins] ${DEMO_FLOOD_ID} `));
    // The app runs in Russian here, and every host-side plugin message is bilingual, so these
    // match either wording rather than pinning a locale.
    const floodMatching = (pattern: RegExp) => floodReports.filter((text) => pattern.test(text));
    // BEFORE: 600 lines here, one per call, each with its own toast. Now: one per (seam, reason).
    expect(
      floodMatching(/contributed nothing to|ничего не добавил/),
      "one report for the 300 malformed panels, one for the 300 malformed rows",
    ).toHaveLength(2);
    expect(
      floodMatching(/contributed too many|добавил слишком много/),
      "one cap report per seam",
    ).toHaveLength(2);
    expect(floodReports, "four messages in total, and not one more").toHaveLength(4);
    // The plugin's GOOD half survived its own flood — the well-formed panels it listed BEFORE the
    // malformed ones are on screen, capped exactly where the cap says.
    await expect(page.getByRole("button", { name: /^Flood 0$/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Flood 3$/ })).toBeVisible({ timeout: 20_000 });
    // …and everything past the cap is dropped silently.
    await expect(page.getByRole("button", { name: /^Late 0$/ })).toHaveCount(0);

    // ── reported once per surface, through the ordinary plugin-problem channel ─────────────────
    //
    // The surface name carries the ENTRY id (`panel:render`, `panel:unmount`, `page:boom`), so two
    // failing panels of one plugin are two reports rather than one — v1 keyed the de-duplication on
    // the surface FAMILY and the second failure of a plugin was invisible.
    const reported = hostLines.filter((text) => text.startsWith(`[plugins] ${DEMO_FAULTY_ID} `));
    const reportedMatching = (pattern: RegExp) => reported.filter((text) => pattern.test(text));
    expect(reportedMatching(/panel:render:/), "one report for the panel body").toHaveLength(1);
    expect(reportedMatching(/page:boom:/), "one for the page body").toHaveLength(1);
    // …and nothing else: the same plugin failing twice on the same surface is ONE report, and the
    // unmount-cleanup throw is React's to catch (see the comment where it happens).
    expect(reported, "two reports for two failing surfaces, and no more").toHaveLength(2);
    // A plugin's render fault is caught by a boundary, so it must never escape as a page error.
    expect(pageErrors, "no uncaught page error").toEqual([]);

    // ── the healthy plugin still works, with the faulty ones loaded beside it ──────────────────
    await expect(demoFooterButton(page)).toBeVisible();
    await closeDemoPanel(page);

    saveEvidenceJson("08-render-faults", {
      spec: "renderFaults.e2e.test.ts",
      faultyPluginId: DEMO_FAULTY_ID,
      suspendPluginId: DEMO_SUSPEND_ID,
      floodPluginId: DEMO_FLOOD_ID,
      reportedProblems: reported,
      suspendReports: suspendReports(),
      floodReports,
      pageErrors,
      consoleErrors,
      hostLines,
    });
  });
});
