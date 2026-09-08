// ru-code (A10) — spec 5: the plugin follows the app's LOCALE and THEME.
//
// Both halves are host-driven and neither costs the plugin any code:
//
//  · THEME — the panel's CSS is written against `var(--background)` / `var(--foreground)`, so the
//    computed background changes with the app's theme and NO plugin code runs. The demo's status
//    line also renders `host.hooks.useTheme()`, so the same switch is observable twice: once
//    through CSS and once through the app's own hook called from a plugin component.
//  · LOCALE — the app RELOADS the document on a language change (`SettingsPanels.tsx` →
//    `window.location.reload()`), and `hooks.useLocale()` is fixed for the lifetime of a document by
//    design (A9 finding MEDIUM-2 — the SDK README now states this contract rather than promising a
//    live switch). So the assertion is: after the real Settings switch and the reload the host
//    performs, EVERY plugin string is in the other language — the panel title, the panel's status
//    line, the Add button, the footer icon's `aria-label` and the composer row labels.
//
// The language is switched BACK in a `finally`: the app is shared by the whole suite, and this is
// the only spec that mutates a persisted app setting.
import {
  closeDemoPanel,
  commandMenu,
  demoFooterButton,
  demoPanel,
  demoStatus,
  expect,
  openAppWithDemo,
  openDemoPanel,
  test,
  typeTrigger,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

/** Read the panel's computed background plus the theme word the plugin's own status line renders. */
const themeFacts = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const element = document.querySelector('[data-testid="demo-panel"]');
    const status = document.querySelector('[data-testid="demo-status"]');
    return {
      background: element === null ? null : getComputedStyle(element).backgroundColor,
      color: element === null ? null : getComputedStyle(element).color,
      status: status?.textContent ?? "",
      documentClass: document.documentElement.className,
    };
  });

async function switchLanguage(
  page: import("@playwright/test").Page,
  option: "English" | "Русский",
): Promise<void> {
  await page
    .getByRole("button", { name: /^(Настройки|Settings)$/ })
    .first()
    .click();
  const trigger = page.getByRole("combobox", { name: /Выбор языка|Language preference/ }).first();
  await expect(trigger, "the Settings language control is on screen").toBeVisible({
    timeout: 30_000,
  });
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).first().click();
  // The host reloads the document on a language change; wait for the app to come back WITH the
  // plugin, rather than for a duration.
  await page.waitForTimeout(1_000);
  await openAppWithDemo(page);
}

test.describe("plugins — locale and theme follow the host", () => {
  test("the theme switch repaints the panel and the locale switch (with the host's reload) flips every plugin string", async ({
    page,
  }) => {
    const evidence: Record<string, unknown> = { spec: "localeTheme.e2e.test.ts" };
    try {
      await openAppWithDemo(page);
      await openDemoPanel(page);

      // ── theme ───────────────────────────────────────────────────────────────────────────────
      await page.emulateMedia({ colorScheme: "light" });
      await expect
        .poll(async () => (await themeFacts(page)).status, { timeout: 15_000 })
        .toMatch(/(тема|theme)\s+light/);
      const light = await themeFacts(page);
      await saveEvidenceScreenshot(page, "05-theme-light");

      await page.emulateMedia({ colorScheme: "dark" });
      await expect
        .poll(async () => (await themeFacts(page)).status, { timeout: 15_000 })
        .toMatch(/(тема|theme)\s+dark/);
      const dark = await themeFacts(page);
      await saveEvidenceScreenshot(page, "05-theme-dark");

      expect(
        dark.background,
        "the panel's computed background follows the theme through var(--background)",
      ).not.toBe(light.background);
      evidence["theme"] = { light, dark };
      await page.emulateMedia({ colorScheme: "light" });

      // ── locale ──────────────────────────────────────────────────────────────────────────────
      const before = {
        title: await page.locator(".ru-demo-title").innerText(),
        status: await demoStatus(page).innerText(),
        add: await page.locator('[data-testid="demo-add"]').innerText(),
        footerLabel: await demoFooterButton(page).getAttribute("aria-label"),
      };
      expect(before.title, "the app boots in Russian").toBe("Демо");
      await closeDemoPanel(page);

      await switchLanguage(page, "English");
      await openDemoPanel(page);
      const after = {
        title: await page.locator(".ru-demo-title").innerText(),
        status: await demoStatus(page).innerText(),
        add: await page.locator('[data-testid="demo-add"]').innerText(),
        footerLabel: await demoFooterButton(page).getAttribute("aria-label"),
      };
      expect(after.title, "the panel title is English after the host's reload").toBe("Demo");
      expect(after.status, "so is the status line the app's own hooks feed").toMatch(
        /connection\s+\S+\s+·\s+locale\s+en\s+·\s+theme\s+\S+/,
      );
      expect(after.add, "and the button inside the panel").toBe("Add");
      expect(after.footerLabel, "and the footer icon's label/tooltip").toBe("Demo");
      await saveEvidenceScreenshot(page, "05-locale-en-panel");

      // …including the composer rows, whose labels were evaluated at `activate()` — correct only
      // BECAUSE the host reloads (A9 finding LOW-1).
      await closeDemoPanel(page);
      await typeTrigger(page, "/demo");
      const menuEn = await commandMenu(page).innerText();
      expect(menuEn, "the composer row label is English too").toContain("Demo context");
      expect(menuEn).not.toContain("Демо-контекст");
      await saveEvidenceScreenshot(page, "05-locale-en-menu");

      evidence["locale"] = { before, after, menuEn };
      saveEvidenceJson("05-locale-theme", evidence);
    } finally {
      // Put the shared app back the way every other spec expects to find it.
      await switchLanguage(page, "Русский").catch(() => undefined);
      await page.emulateMedia({ colorScheme: "light" }).catch(() => undefined);
    }

    await openDemoPanel(page);
    await expect(demoPanel(page).locator(".ru-demo-title")).toHaveText("Демо");
    await closeDemoPanel(page);
  });
});
