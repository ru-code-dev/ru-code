// ru-code v2 (V2-33) — `ctx.pickFolder`: the HOST-owned folder picker, from a plugin, in a real
// browser.
//
// THE CLAIM. A plugin asks for one folder and gets back the absolute path the user chose, or
// `null`. What opens is the APP's command palette in a new mode, `folder` — the same chrome, the
// same browse rows and the same "type a path by hand" input its own Add-project flow has — over the
// primary environment's real disk, folders only. The plugin never sees any of that: the demo's tab
// panel has one button (`demo-add-folder`) and one list (`demo-folders`), and that is the whole of
// what a plugin writes (`packages/plugin-demo/src/web/DemoPanel.tsx` `DemoFolderPicks`).
//
// WHY IT NEEDS A BROWSER. The request store is unit-tested
// (`apps/web/src/ru-code/tests/plugins/folderPicker.test.ts`) and the `start` validation with it
// (`ctx.test.ts`); the palette MODE — the dialog opening on a request, the browse RPC, the typed
// path resolving to the server's absolute form, Enter picking and Esc cancelling — exists only
// here.
//
// THE FOLDER IT PICKS IS REAL: the harness's own temp root (`state().tmpRoot`), which exists on the
// machine the server runs on, so the browse RPC lists it and the typed path resolves. The
// resolved value is asserted against `fs.realpathSync` of that root — the server answers with the
// path as IT sees it (`~` expanded, symlinks as the OS reports them), which is exactly the string a
// plugin should receive.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

import { expect, openChat, state, test, type Page } from "./fixtures.ts";

const DEMO_TAB_LABEL = /^(Демо-вкладка|Demo tab)$/;
const RIGHT_PANEL_TOGGLE = /^(Переключить правую панель|Toggle right panel)/;

const launcher = (page: Page) => page.locator("[data-surface-launcher-keys]");
const picker = (page: Page) => page.locator('[data-testid="plugin-folder-picker"]');
const pickerInput = (page: Page) => picker(page).locator("input").first();
const dialog = (page: Page) => page.locator('[data-testid="command-palette"]');
const addFolder = (page: Page) => page.locator('[data-testid="demo-add-folder"]').first();
const folders = (page: Page) => page.locator('[data-testid="demo-folders"] li');

/** Start from an empty right panel, as `pluginTabs.e2e.test.ts` does, then open the demo tab. */
const openDemoTab = async (page: Page): Promise<void> => {
  await openChat(page);
  await page.evaluate(() => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.includes("right-panel-state")) window.localStorage.removeItem(key);
    }
  });
  await openChat(page);
  if (
    !(await launcher(page)
      .isVisible()
      .catch(() => false))
  ) {
    const toggle = page.getByRole("button", { name: RIGHT_PANEL_TOGGLE }).first();
    await expect(toggle, "the app's right-panel toggle").toBeVisible({ timeout: 30_000 });
    await toggle.dispatchEvent("click", { timeout: 15_000 });
  }
  await expect(launcher(page), "the launcher").toBeVisible({ timeout: 30_000 });
  const card = launcher(page)
    .getByRole("button", { name: new RegExp(`^(?:${DEMO_TAB_LABEL.source.slice(2, -2)})(?= |$)`) })
    .first();
  await expect(card, "the demo's tab card").toBeVisible({ timeout: 30_000 });
  const clicked = await card
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await card.dispatchEvent("click", { timeout: 15_000 });
  await expect(addFolder(page), "the demo's Add folder button").toBeVisible({ timeout: 30_000 });
};

test.describe("plugins — `ctx.pickFolder` opens the host's folder picker (V2-33)", () => {
  test("Add folder opens the app's palette in folder mode; a typed path + Enter is the answer", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openDemoTab(page);
    const root = state().tmpRoot;
    const expected = NodeFS.realpathSync(root);

    // (a) the plugin's button opens the APP's own dialog, in the new mode — not a plugin dialog.
    await addFolder(page).dispatchEvent("click", { timeout: 15_000 });
    await expect(dialog(page), "the app's command palette").toBeVisible({ timeout: 30_000 });
    await expect(dialog(page)).toHaveAttribute("data-palette-mode", "folder");
    await expect(picker(page), "in its folder mode").toBeVisible();
    // S33 A11: the reference implementation guards its button while its pick is in flight — the
    // shape the SDK asks every author for (one pending `pickFolder` per plugin).
    await expect(
      addFolder(page),
      "the demo's button is disabled while its pick is open",
    ).toBeDisabled();
    expect(
      await picker(page).evaluate((node) => node.closest("[data-plugin-root]") !== null),
      "the picker is host chrome, outside every plugin's CSS scope",
    ).toBe(false);
    // With no `start`, it opens at home: the input already holds `~/`. (The harness's home is a
    // bare temp directory with nothing but hidden entries, so the rows are asserted one step
    // below, on a folder that has children.)
    await expect(pickerInput(page)).toHaveValue("~/");
    await saveEvidenceScreenshot(page, "plugin-pick-folder-open");

    // (b) the user types a path by hand — the add-project input, unchanged. The parent of the temp
    // root lists the root itself as a row: the rows are the SERVER's folder list, folders only.
    await pickerInput(page).fill(`${NodePath.dirname(root)}${NodePath.sep}`);
    await expect(
      picker(page)
        .getByRole("option", { name: NodePath.basename(root) })
        .first(),
      "the browse rows — the server's folder list, with the temp root among them",
    ).toBeVisible({ timeout: 30_000 });
    // …then the folder itself, and Enter.
    await pickerInput(page).fill(`${root}${NodePath.sep}`);
    await expect(
      picker(page).locator('[data-testid="plugin-folder-picker-add"]'),
      "the Add folder action is enabled once the server has listed the folder",
    ).toBeEnabled({ timeout: 30_000 });
    await pickerInput(page).press("Enter");
    await expect(dialog(page), "the palette closes on a pick").toHaveCount(0, { timeout: 30_000 });
    // (c) the plugin got the ABSOLUTE path, as the server sees it.
    await expect(folders(page), "the demo lists the answer").toHaveCount(1, { timeout: 30_000 });
    const picked = await folders(page).first().innerText();
    expect(picked, "an absolute path, no trailing separator").toBe(expected);
    await expect(addFolder(page), "…and the button is usable again once answered").toBeEnabled();

    await saveEvidenceScreenshot(page, "plugin-pick-folder-picked");
    saveEvidenceJson("plugin-pick-folder", {
      spec: "pickFolder.e2e.test.ts",
      typed: `${root}${NodePath.sep}`,
      picked,
    });
  });

  test("Esc answers `null`: the palette closes and the plugin adds nothing", async ({ page }) => {
    test.setTimeout(180_000);
    await openDemoTab(page);
    const before = await folders(page).count();
    await addFolder(page).dispatchEvent("click", { timeout: 15_000 });
    await expect(dialog(page)).toHaveAttribute("data-palette-mode", "folder", { timeout: 30_000 });
    await pickerInput(page).press("Escape");
    await expect(
      dialog(page),
      "Esc closes the picker outright — no fall-through to command mode",
    ).toHaveCount(0, { timeout: 30_000 });
    // Nothing was added, and the plugin is not left waiting: a second ask opens a fresh picker.
    expect(await folders(page).count()).toBe(before);
    await addFolder(page).dispatchEvent("click", { timeout: 15_000 });
    await expect(dialog(page)).toHaveAttribute("data-palette-mode", "folder", { timeout: 30_000 });
    // The backdrop is a cancel too.
    await page.mouse.click(5, 5);
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    expect(await folders(page).count()).toBe(before);
    saveEvidenceJson("plugin-pick-folder-cancel", {
      spec: "pickFolder.e2e.test.ts",
      foldersBefore: before,
      foldersAfter: await folders(page).count(),
    });
  });
  // S33 A5: the palette is the USER's surface first. A request that arrives while they are in ⌘K
  // waits — their query survives, nothing is unmounted under them — and the picker opens the
  // moment they close the palette themselves. Before the fix the body was swapped at once and the
  // typed query was gone.
  test("a request made while the user is in ⌘K WAITS: the query survives, the picker opens once the palette closes", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openDemoTab(page);

    // The user opens the command palette (`mod+k`) and types.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog(page), "the user's palette").toBeVisible({ timeout: 30_000 });
    await expect(dialog(page)).toHaveAttribute("data-palette-mode", "command");
    const input = dialog(page).locator("input").first();
    await input.fill("hello from the user");
    await expect(input).toHaveValue("hello from the user");

    // The plugin asks meanwhile — behind the modal; `dispatchEvent` needs no actionability.
    await addFolder(page).dispatchEvent("click", { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await expect(dialog(page), "still the user's palette").toHaveAttribute(
      "data-palette-mode",
      "command",
    );
    await expect(input, "the query survived").toHaveValue("hello from the user");
    expect(await picker(page).count(), "no picker while the user is in the palette").toBe(0);
    await saveEvidenceScreenshot(page, "plugin-pick-folder-waits");

    // The user is done: Esc closes THEIR palette — and the waiting request opens the picker.
    await page.keyboard.press("Escape");
    await expect(dialog(page), "the picker, once the palette was free").toHaveAttribute(
      "data-palette-mode",
      "folder",
      { timeout: 30_000 },
    );
    await expect(picker(page)).toBeVisible();
    await expect(pickerInput(page)).toHaveValue("~/");

    // Esc answers `null`, as ever: the plugin adds nothing and the dialog is gone.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(folders(page)).toHaveCount(0);
    saveEvidenceJson("plugin-pick-folder-waits", {
      spec: "pickFolder.e2e.test.ts",
      queryKept: "hello from the user",
    });
  });
});
