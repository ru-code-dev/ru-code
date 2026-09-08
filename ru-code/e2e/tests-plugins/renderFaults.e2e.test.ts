// ru-code (A13) — spec 8: plugin REACT that throws stays inside the plugin.
//
// A12's two HIGH findings, as a browser fact:
//
//  · R1-H1 — a panel `icon` that throws. It is rendered by `SidebarChrome`'s footer row on EVERY
//    page load, with no boundary above it, so four lines of plugin code replaced the whole SPA with
//    the app's crash card — and because the plugin reloads with the page, a reload could not
//    recover it. The only fix was deleting the folder from a shell, which is exactly the recovery
//    A4's H2 was fixed to eliminate.
//  · R1-H2 — a panel `render` that throws. Same missing boundary, on the click path: the app booted
//    healthy and then became the crash card the moment the footer icon was pressed.
//  · R2-H1 (round 2) — a panel whose effect CLEANUP throws. It opens healthy and dies on CLOSE:
//    the cleanup runs during the commit that REMOVES the subtree, so every boundary inside the
//    panel is being destroyed in that same commit and React walked past them to the router root —
//    the crash card again, this time with no attribution at all. The fix is a boundary that
//    OUTLIVES the panel (`RightGlobalPanelHost` mounts one for the slot) plus a plugin-aware root
//    error view; what this spec asserts is the user-visible half: the panel closes, the app is
//    intact, and exactly one report names the plugin.
//
// The fix wraps both surfaces at the ONE host seam (`apps/web/src/ru-code/plugins/hostApi.ts` →
// `renderSafety.tsx`), so this spec asserts what a user would see: the app is up, the button is
// still there with a warning glyph, the panel opens with a fallback card naming the plugin and the
// error, closing it works, and the healthy demo plugin next door is untouched throughout.
//
// WHY IT INSTALLS AND RESTARTS. `PluginHost.start` scans once per process, so a plugin dropped in
// after the spawn does not exist for that process. Seeding this fixture at globalSetup instead
// would have changed the expectations of six other specs (`isolation` counts console errors,
// `manifests` enumerates the folder) for this one spec's benefit. It therefore installs, restarts,
// asserts, removes and restarts again — leaving the harness exactly as it found it for
// `uninstall.e2e.test.ts`, which sorts after this file.
// @effect-diagnostics globalDate:off
import type { Locator } from "@playwright/test";

import {
  closeDemoPanel,
  demoFooterButton,
  expect,
  openAppWithDemo,
  state,
  test,
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

const ICON_PANEL = /^Boom icon$/;
const RENDER_PANEL = /^Boom render$/;
const UNMOUNT_PANEL = /^Boom unmount$/;

/** The suite's own click idiom (`fixtures.ts:toggleDemoPanel`): real click, bounded fallback. */
const clickOrDispatch = async (locator: Locator): Promise<void> => {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const clicked = await locator
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await locator.dispatchEvent("click");
};

test.describe("plugins — a panel icon or render that throws never reaches the host", () => {
  // Two full server restarts inside one spec; the default 120 s covers neither.
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    const current = state();
    await stopPluginsApp(current);
    installFaultyPlugin(current.pluginsDir);
    // A12 round 3: React that SUSPENDS (R3-H1/R3-H2) and a registration flood (R3-H4), each its
    // own plugin so their reports cannot be de-duplicated into one another's.
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

  test("the app boots, the panel degrades to a fallback, and the failure is reported once", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // ── R1-H1: the app is INTERACTIVE with a throwing icon in the footer ───────────────────────
    //
    // BEFORE: this navigation ended on «Что-то пошло не так. / A12 icon boom» — the composer never
    // appeared (A12 measured a 60 883 ms timeout waiting for it) and every reload did the same.
    await openAppWithDemo(page);
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible({
      timeout: 30_000,
    });

    const iconButton = page.getByRole("button", { name: ICON_PANEL });
    const renderButton = page.getByRole("button", { name: RENDER_PANEL });
    await expect(iconButton, "the throwing icon still has its button").toBeVisible({
      timeout: 30_000,
    });
    await expect(renderButton).toBeVisible({ timeout: 30_000 });

    // The button carries the host's fallback glyph, not the plugin's component.
    const fallbackIcon = page.locator(`[data-plugin-icon-failed="${DEMO_FAULTY_ID}"]`);
    await expect(fallbackIcon, "a generic warning glyph replaces the throwing icon").toHaveCount(1);
    await expect(fallbackIcon).toHaveAttribute("aria-label", /plugin failed|плагин не работает/);

    // The healthy plugin is untouched.
    await expect(demoFooterButton(page)).toBeVisible({ timeout: 30_000 });
    await saveEvidenceScreenshot(page, "08-app-with-faulty-icon");

    // ── R1-H2: opening the throwing panel gives a fallback CARD, not the crash card ────────────
    //
    // A real pointer click, with the suite's bounded `dispatchEvent` fallback: the plugin's own
    // failure toasts are on screen while this runs, and a toast CARD legitimately covers the
    // corner it is drawn in (A10 P2 — what A13 fixed is the empty portal box around the cards).
    await clickOrDispatch(renderButton);
    const fallbackCard = page.locator('[data-slot="plugin-panel-failed"]');
    await expect(fallbackCard, "the panel body degrades in place").toBeVisible({ timeout: 20_000 });
    await expect(fallbackCard).toContainText(/Demo \(faulty\)/);
    await expect(fallbackCard).toContainText("A12 panel render boom");
    // BEFORE: `rootChildren` collapsed from 78 684 to 4 930 and the composer was gone.
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app is still there behind the failed panel",
    ).toBeVisible();
    await saveEvidenceScreenshot(page, "08-panel-render-fallback");

    // The fallback's own close button works — a failed panel is not a trap.
    await clickOrDispatch(fallbackCard.getByRole("button").first());
    await expect(fallbackCard).toBeHidden({ timeout: 20_000 });

    // ── R2-H1: a panel whose effect CLEANUP throws dies on CLOSE, and takes nothing with it ───
    //
    // BEFORE (A12 round 2): open → «body», CLOSE → the whole viewport became «Что-то пошло не
    // так. / A12 panel unmount boom», `#root` collapsed from 80 679 to 4 906 characters, and
    // there was NO attribution at all — no `[plugins] …` line and no toast, because
    // `reportRenderFault` was never reached.
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
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app survived the unmount throw",
    ).toBeVisible();
    // The crash card is the router's own error view; it must not be on screen.
    await expect(
      page.getByRole("heading", { name: /Something went wrong|Что-то пошло не так/ }),
    ).toBeHidden();
    await expect(demoFooterButton(page), "the healthy plugin is still there").toBeVisible();
    await saveEvidenceScreenshot(page, "08-panel-unmount-closed");

    // ── R3-H1: an icon that SUSPENDS forever, and one that resolves late ───────────────────────
    //
    // BEFORE: `React.lazy(() => new Promise(() => {}))` as a panel icon rendered a pure white
    // 1440×900 viewport at boot. The composer never appeared inside 60 s, `#root.innerHTML` was 0
    // characters, and there was no crash card, no toast, no console message and no page error —
    // guardrail 8 broken more completely than R1-H1 broke it, and recoverable only from a shell.
    // The app is up (asserted above), so the containment already held; these assert the SHAPE.
    const hangButton = page.getByRole("button", { name: /^Hang icon$/ });
    await expect(hangButton, "the hanging icon still has its button").toBeVisible({
      timeout: 30_000,
    });
    const pendingIcons = page.locator(`[data-plugin-icon-pending="${DEMO_SUSPEND_ID}"]`);
    await expect(pendingIcons, "a neutral placeholder stands in for a suspended icon").toHaveCount(
      1,
      { timeout: 30_000 },
    );
    // The control resolved after 3 s: its button carries the REAL glyph, not a placeholder — which
    // is what makes the Suspense a containment and not a refusal of `lazy`.
    const lateButton = page.getByRole("button", { name: /^Late icon$/ });
    await expect(lateButton).toBeVisible({ timeout: 30_000 });
    await expect(lateButton.locator("svg")).toHaveCount(1, { timeout: 30_000 });
    await saveEvidenceScreenshot(page, "08-suspended-icon");

    // ── R3-H2: a render that returns a PENDING promise ─────────────────────────────────────────
    //
    // BEFORE: clicking this footer icon blanked the viewport (composer gone, `#root` intact at
    // 80 167 characters because React hides suspended content with `display:none`), and CLOSING
    // the panel did not bring it back — only a reload did.
    const promiseButton = page.getByRole("button", { name: /^Promise render$/ });
    await clickOrDispatch(promiseButton);
    const promiseCard = page.locator('[data-slot="plugin-panel-failed"]');
    await expect(promiseCard, "a thenable result is refused at the seam").toBeVisible({
      timeout: 20_000,
    });
    await expect(promiseCard).toContainText(/Demo \(suspend\)/);
    await expect(promiseCard).toContainText(/Promise|ReactNode/);
    await expect(
      page.locator('div[contenteditable="true"]').first(),
      "the app is still there behind the refused panel",
    ).toBeVisible();
    await saveEvidenceScreenshot(page, "08-promise-render-fallback");
    // …and closing it leaves the app running, which is the half that never recovered before.
    await clickOrDispatch(promiseButton);
    await expect(promiseCard).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('div[contenteditable="true"]').first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Something went wrong|Что-то пошло не так/ }),
    ).toBeHidden();

    // ── R3-H4: 300 malformed + 1000 well-formed registrations, in one plugin ───────────────────
    //
    // BEFORE: 600 reports, and the tab stopped answering — the composer never appeared inside
    // 60 s, `page.evaluate("1+1")` timed out at 20 s and `page.screenshot` timed out twice at
    // 25 s, so the auditor could not even photograph it. The app being interactive here (every
    // assertion above ran against this same page) IS the fix.
    expect(await page.evaluate("1 + 1"), "the page still answers").toBe(2);
    const floodReports = consoleErrors.filter((text) =>
      text.includes(`[plugins] ${DEMO_FLOOD_ID}:`),
    );
    // The app runs in Russian here, and every host-side plugin message is bilingual (A4 M4), so
    // these match either wording rather than pinning a locale.
    const floodMatching = (pattern: RegExp) => floodReports.filter((text) => pattern.test(text));
    // BEFORE: 600 lines here, one per call, each with its own toast.
    expect(floodReports, "four messages in total, and not one more").toHaveLength(4);
    expect(
      floodMatching(/invalid panel fields|поля панели/),
      "one report for 300 malformed panels",
    ).toHaveLength(1);
    expect(
      floodMatching(/invalid composer item fields|пункта композера/),
      "one report for 300 malformed composer rows",
    ).toHaveLength(1);
    expect(
      floodMatching(/registration calls|вызовов регистрации/),
      "one ceiling report per surface",
    ).toHaveLength(2);
    // The plugin's GOOD half survived its own flood — the four well-formed panels it registered
    // before the malformed ones are on screen, capped exactly as R1-M5 left them.
    await expect(page.getByRole("button", { name: /^Flood 0$/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Flood 3$/ })).toBeVisible({ timeout: 20_000 });
    // …and the 1000 well-formed registrations that came AFTER the ceiling are ignored silently.
    await expect(page.getByRole("button", { name: /^Late 0$/ })).toHaveCount(0);

    // ── reported once per surface, through the ordinary plugin-problem channel ─────────────────
    const reported = consoleErrors.filter((text) => text.includes(`[plugins] ${DEMO_FAULTY_ID}:`));
    expect(
      reported.filter((text) => text.includes("icon:")),
      "one report for the icon",
    ).toHaveLength(1);
    expect(
      reported.filter((text) => text.includes("render:")),
      "one report for the panel body",
    ).toHaveLength(1);
    // BEFORE: zero — the unmount fault reached no boundary at all (R2-H1).
    expect(
      reported.filter((text) => text.includes("panel:")),
      "one report for the unmount cleanup",
    ).toHaveLength(1);
    // A plugin's render fault is caught by a boundary, so it must never escape as a page error.
    expect(pageErrors, "no uncaught page error").toEqual([]);

    // R3-H1/R3-H2, the diagnostic half: a surface that is STILL suspended when its 10 s budget
    // runs out is named, once — React reports nothing itself, which is why the blank page was
    // undebuggable. The promise render was refused at the seam and reported immediately.
    const suspendReports = () =>
      consoleErrors.filter((text) => text.includes(`[plugins] ${DEMO_SUSPEND_ID}:`));
    await expect
      .poll(() => suspendReports().filter((text) => text.includes("icon:")).length, {
        timeout: 30_000,
      })
      .toBe(1);
    expect(
      suspendReports().filter((text) => text.includes("render:")),
      "one report for the refused thenable",
    ).toHaveLength(1);

    // ── the healthy plugin still works, with the faulty one loaded beside it ───────────────────
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
    });
  });
});
