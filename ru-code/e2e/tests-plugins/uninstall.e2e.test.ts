// ru-code (A10) — spec 7: delete the folder, restart, nothing remains — and the DATA is kept.
//
// The second half of the drop-in contract, and the only spec that has to move the server: the host
// scans the plugins directory once at boot (hot re-scan is backlog), so "the folder is gone" is only
// a real fact after a restart. The harness stops the app, deletes `plugins/demo`, and starts it
// again ON THE SAME PORT — the saved storage state (cookies, localStorage AND the IndexedDB
// environment registration) is bound to that origin, so a new port would hand the page an
// unauthenticated app and every assertion below would fail for the wrong reason.
//
// Afterwards, five ways of asking "is it really gone?", because each covers a different registry:
// the manifest list, the HTTP routes, the panel registry (footer icon), the stylesheet link, and all
// three composer menus. Then the one thing that must NOT be gone: `userdata/plugins/demo/data.sqlite`
// (D11 — no purge in the MVP), still carrying its `_plugin_migrations` rows.
//
// It runs LAST: `uninstall.e2e.test.ts` sorts after every other file name in `tests-plugins/`, and
// the suite is `workers: 1, fullyParallel: false`.
import {
  addDemoNote,
  clearDemoNotes,
  closeDemoPanel,
  commandMenuText,
  composer,
  DEMO_ID,
  demoFooterButton,
  expect,
  fetchManifests,
  focusComposer,
  openAppWithDemo,
  openDemoPanel,
  readPluginDatabase,
  state,
  statusOf,
  test,
} from "./fixtures.ts";
import { removePluginFolder, restartPluginsApp, stopPluginsApp } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const KEPT_NOTE = "this note must survive the uninstall";

test.describe("plugins — uninstall by deleting the folder", () => {
  // This spec stops and restarts the server inside itself; the default 120 s covers the browser
  // work but not a whole extra boot on top of it.
  test.setTimeout(240_000);

  test("after a restart nothing of the plugin remains in the app, and its data folder is untouched", async ({
    page,
  }) => {
    const t0 = Date.now();
    const mark = (label: string): void => {
      process.stdout.write(`[uninstall] ${label} @ ${String(Date.now() - t0)}ms\n`);
    };
    // ── write one note, so "the data is kept" is about content, not about a file existing ───────
    await openAppWithDemo(page);
    mark("app open");
    await openDemoPanel(page);
    mark("panel open");
    await clearDemoNotes(page);
    await addDemoNote(page, KEPT_NOTE);
    await closeDemoPanel(page);
    mark("note written");

    const before = await readPluginDatabase(DEMO_ID);
    expect(before.exists, "the plugin has its own database").toBe(true);
    expect(before.migrations, "both migrations were applied once (D10)").toEqual([
      "001-notes",
      "002-notes-index",
    ]);
    expect(before.notes).toContain(KEPT_NOTE);

    // ── stop, delete the folder, restart ───────────────────────────────────────────────────────
    const running = state();
    await stopPluginsApp(running);
    mark("server stopped");
    removePluginFolder(running.pluginsDir, DEMO_ID);
    await restartPluginsApp(running);
    mark("server restarted");

    // ── nothing of the plugin is left ──────────────────────────────────────────────────────────
    const manifests = await fetchManifests();
    mark("manifests read");
    expect(
      manifests.map((row) => row.id),
      "the deleted plugin is no longer in manifests.json",
    ).not.toContain(DEMO_ID);
    expect(await statusOf(`/plugins/${DEMO_ID}/web/index.mjs`), "its web entry 404s").toBe(404);
    expect(await statusOf(`/plugins/${DEMO_ID}/web/styles.css`), "its stylesheet 404s").toBe(404);

    await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first()).toBeAttached(
      {
        timeout: 60_000,
      },
    );
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    // Give the loader more than its whole budget to prove it registers nothing.
    await page.waitForTimeout(3_000);
    mark("page reloaded");

    expect(await demoFooterButton(page).count(), "no footer icon").toBe(0);
    expect(await page.locator('[data-testid="demo-panel"]').count(), "no panel").toBe(0);
    const pluginStylesheets = await page.evaluate(() =>
      [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => href.includes("/plugins/")),
    );
    expect(pluginStylesheets, "no plugin stylesheet link").toEqual([]);

    // Typed WITHOUT `typeTrigger`: that helper waits for the menu to open, and the whole point
    // here is that the plugin contributes nothing — a menu that never opens (because the plugin
    // was the only match) is a PASS, not something to wait 20 s for three times over.
    const menus: Record<string, string> = {};
    for (const [key, trigger] of [
      ["slash", "/demo"],
      ["skill", "$demo"],
      ["agent", "#demo"],
    ] as const) {
      await focusComposer(page);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(trigger, { delay: 30 });
      await page.waitForTimeout(1_500);
      menus[key] = await commandMenuText(page);
      mark(`menu ${key} read`);
      expect(menus[key], `the ${key} menu lists nothing from the plugin`).not.toMatch(
        /Демо-контекст|Demo context|Демо-заметки|Demo notes|Демо-ассистент|Demo assistant/,
      );
      expect(
        await page.evaluate(() => document.body.innerText),
        `nothing from the plugin is on screen for ${trigger}`,
      ).not.toMatch(
        /Демо-контекст|Demo context|Демо-заметки|Demo notes|Демо-ассистент|Demo assistant/,
      );
    }
    await composer(page).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    mark("menus checked");
    await saveEvidenceScreenshot(page, "07-uninstalled");

    // ── but the DATA is kept (D11) ─────────────────────────────────────────────────────────────
    const after = await readPluginDatabase(DEMO_ID);
    expect(after.exists, "the plugin's data folder survives the uninstall (D11)").toBe(true);
    expect(after.migrations).toEqual(before.migrations);
    expect(after.notes, "with its rows intact").toContain(KEPT_NOTE);

    saveEvidenceJson("07-uninstall", {
      spec: "uninstall.e2e.test.ts",
      manifestsAfter: manifests,
      webEntryStatus: await statusOf(`/plugins/${DEMO_ID}/web/index.mjs`),
      stylesStatus: await statusOf(`/plugins/${DEMO_ID}/web/styles.css`),
      pluginStylesheets,
      menus,
      database: { before, after },
    });
  });
});
