// ru-code (A10) — spec 2: the footer icon, the panel, and the note round-trip.
//
// The visible half of the drop-in claim. Four things, each proving a different seam:
//
//  1. the footer icon is ATTACHED WITHIN 3 s of the app being usable, even though a sibling plugin
//     hangs for 10 s. `loadPlugins()` runs below `createRoot` and the registries are reactive
//     (A4 findings H2/M2) — if that regressed, the icon would appear only after the hang's budget
//     expired, and this is the assertion that would notice;
//  2. clicking it opens the panel and the panel's stylesheet is really applied (`.ru-demo-panel`'s
//     own rules, not browser defaults) — i.e. `web/styles.css` was linked and parsed;
//  3. the status line carries connection/locale/theme, all three read from the APP's own hooks by a
//     component the plugin owns. A second React instance would have thrown "Invalid hook call" on
//     mount instead of rendering this line;
//  4. two notes go through `host.invoke` → the plugin's own SQLite file → back, survive a full page
//     reload (so they were written to disk, not held in the store), and a remove updates the list.
import {
  addDemoNote,
  clearDemoNotes,
  clickPanelControl,
  closeDemoPanel,
  demoFooterButton,
  demoNoteBodies,
  demoPanel,
  demoStatus,
  expect,
  openDemoPanel,
  state,
  test,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

/** The web loader's per-plugin budget is 10 s; the icon must be up long before the hang blows it. */
const ICON_BUDGET_MS = 3_000;

test.describe("plugins — footer icon, panel and the note round-trip", () => {
  test("the icon appears within 3 s, the panel renders on the host's hooks, notes round-trip and persist", async ({
    page,
  }) => {
    const startedAt = Date.now();
    await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
    // The APP first — it must be interactive without waiting for any plugin.
    await expect(page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first()).toBeAttached(
      {
        timeout: 30_000,
      },
    );
    const appReadyMs = Date.now() - startedAt;
    // …then the plugin's icon, within its own budget measured from the app being ready. The
    // TIMEOUT is the assertion: blowing it is exactly the regression (a boot that waits on
    // `loadPlugins()` would surface the icon only after the hanging sibling's 10 s expires).
    await expect(
      demoFooterButton(page),
      `the demo icon must attach within ${String(ICON_BUDGET_MS)}ms of the app being ready, not after the hanging plugin's 10 s budget`,
    ).toBeAttached({ timeout: ICON_BUDGET_MS });
    const iconMs = Date.now() - startedAt;

    // A CLOSE-UP with the tooltip open: at 1440×900 the footer icons are 16 px and a full-viewport
    // shot cannot show that this one is the plugin's, or that its label is the manifest's.
    await demoFooterButton(page).hover();
    await expect(
      page
        .getByRole("tooltip")
        .filter({ hasText: /^(Демо|Demo)$/ })
        .first(),
    )
      .toBeVisible({ timeout: 10_000 })
      .catch(() => undefined);
    const iconBox = await demoFooterButton(page).boundingBox();
    // ru-code (A13): the options object is BUILT by the conditional rather than spread into a new
    // one — `unicorn/no-useless-spread` (a warning the repo's lint gate counts) flagged the spread,
    // and the two arms are the whole value anyway.
    await saveEvidenceScreenshot(
      page,
      "02-footer-icon",
      iconBox === null
        ? {}
        : {
            clip: {
              x: Math.max(0, iconBox.x - 24),
              y: Math.max(0, iconBox.y - 140),
              width: 420,
              height: 200,
            },
          },
    );
    await page.mouse.move(700, 400);

    // ── the panel ─────────────────────────────────────────────────────────────────────────────
    await openDemoPanel(page);
    const panelFacts = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="demo-panel"]');
      if (element === null) return null;
      const style = getComputedStyle(element);
      return {
        className: element.className,
        display: style.display,
        flexDirection: style.flexDirection,
        gap: style.gap,
        fontSize: style.fontSize,
        backgroundColor: style.backgroundColor,
        stylesheetLinks: [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((link) => link.getAttribute("href") ?? "")
          .filter((href) => href.includes("/plugins/")),
        right: element.getBoundingClientRect().right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(panelFacts, "the panel rendered").not.toBeNull();
    // `web/styles.css`: `.ru-demo-panel { display:flex; flex-direction:column; gap:10px; font-size:13px }`
    expect(panelFacts?.display).toBe("flex");
    expect(panelFacts?.flexDirection).toBe("column");
    expect(panelFacts?.gap).toBe("10px");
    expect(panelFacts?.fontSize).toBe("13px");
    expect(panelFacts?.stylesheetLinks).toContain("/plugins/demo/web/styles.css");
    // Geometry is recorded, not asserted: where the host docks an overlay panel is the app's
    // layout decision (and it moves with the window), while what this spec owns is that the
    // plugin's OWN stylesheet reached the page and applied.

    const statusLine = await demoStatus(page).innerText();
    expect(
      statusLine,
      "the status line carries connection/locale/theme from the app's own hooks",
    ).toMatch(
      /(соединение\s+\S+\s+·\s+язык\s+\S+\s+·\s+тема\s+\S+)|(connection\s+\S+\s+·\s+locale\s+\S+\s+·\s+theme\s+\S+)/,
    );
    await saveEvidenceScreenshot(page, "02-panel-open");

    // ── the note round-trip ───────────────────────────────────────────────────────────────────
    await clearDemoNotes(page);
    expect(await demoNoteBodies(page), "the panel starts from an empty database").toEqual([]);
    await addDemoNote(page, "alpha note");
    await addDemoNote(page, "beta note");
    // Newest first — the server's `ORDER BY created_at DESC, id DESC`.
    expect(await demoNoteBodies(page)).toEqual(["beta note", "alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-two");

    // A full reload proves the round-trip reached the plugin's own SQLite file rather than a store.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(demoFooterButton(page)).toBeAttached({ timeout: 30_000 });
    await openDemoPanel(page);
    await expect
      .poll(() => demoNoteBodies(page), {
        timeout: 30_000,
        message: "the notes survive a reload",
      })
      .toEqual(["beta note", "alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-after-reload");

    // …and a remove is a real DELETE that the next list reflects.
    const firstRemoveId = await page
      .locator('[data-testid^="demo-remove-"]')
      .first()
      .getAttribute("data-testid");
    await clickPanelControl(page, firstRemoveId ?? "demo-remove-0");
    await expect
      .poll(() => demoNoteBodies(page), { timeout: 20_000, message: "one note was removed" })
      .toEqual(["alpha note"]);
    await saveEvidenceScreenshot(page, "02-notes-after-remove");

    saveEvidenceJson("02-panel", {
      spec: "panel.e2e.test.ts",
      appReadyMs,
      demoIconAttachedMs: iconMs,
      iconBudgetMs: ICON_BUDGET_MS,
      statusLine,
      panel: panelFacts,
      notesAfterRemove: await demoNoteBodies(page),
    });

    await clearDemoNotes(page);
    await closeDemoPanel(page);
    await expect(demoPanel(page)).toBeHidden();
  });
});
