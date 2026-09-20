// ru-code v2 (V2-27) — PLUGIN PANELS AS TABS of the app's thread right panel, in a real browser.
//
// THE CLAIM. A panel a plugin declares with `mount: "tab"` is a surface of the app's OWN tabbed
// panel — a card in its launcher, a tab beside Diff and Files, a body inside the plugin's CSS
// scope, per thread, singleton by id — and the host learns nothing about which plugin it is: the
// title, the icon NAME and the nav label all come back through the `panels` seam
// (`apps/web/src/ru-code/plugins/tabSurfaces.tsx`).
//
// WHY IT NEEDS A BROWSER. The store, the reconcile and `ctx.closePanel`'s tab arm are unit-tested
// in `apps/web/src/ru-code/tests/plugins/tabSurfaces.test.ts`; `apps/web`'s unit project runs in
// Node, so the two HOOKS (the launcher's cards and `ChatView`'s one line publishing the thread) and
// everything the user actually sees exist only here.
//
// THE TWO PLUGINS ARE BOTH LOAD-BEARING. `catalogs` proves the real port: skills and agents are
// tabs, commands stays in the GLOBAL slot, and one plugin can have panels in both places at once.
// `demo` proves the contract's own edge — `ctx.closePanel(id)` closing a TAB — with the same button
// its global panel uses, because that is the seam a plugin author writes once for both mounts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEMO_ID,
  composer,
  demoFooterButton,
  expect,
  openChat,
  state,
  test,
  type Page,
} from "./fixtures.ts";
import {
  DEMO_NAMED_ID,
  installNamedPlugin,
  installPluginFolder,
  removePluginFolder,
  restartPluginsApp,
  stopPluginsApp,
  type PluginsHarnessState,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

// The three labels, in both arms of the plugins' own `L(en, ru)` (the app boots in Russian and
// `localeTheme.e2e.test.ts` may have switched it). S22: the catalogs plugin titles its panels
// «Менеджер Навыков» / «Менеджер Агентов» / «Менеджер Команд» now.
//
// ANCHORED for the footer rail and the tab strip, where the accessible name is exactly the label:
// a footer button's is its `aria-label`, and a tab's is its title span. UNANCHORED inside the
// launcher and the "+" menu, where an entry's accessible name is its label PLUS its description —
// the plugin's own `Panel.description` (S22, `RightPanelTabs.tsx`), e.g. "Менеджер Навыков Навыки
// проекта и профиля".
const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const AGENTS_LABEL = /^(Менеджер Агентов|Agent manager)$/;
const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
const DEMO_TAB_LABEL = /^(Демо-вкладка|Demo tab)$/;
/** The plugins' own `Panel.description` lines (S22) — the second line under a card / menu entry. */
const SKILLS_DESCRIPTION = /Навыки проекта и профиля|Skills of this project and the profile/;
const DEMO_TAB_DESCRIPTION = /Заметки демо рядом с диалогом|The demo's notes, beside the thread/;
/**
 * The generated `demo-named` fixture (S15 B1), whose three strings are deliberately unlike each
 * other: the PANEL's title, the PLUGIN's manifest name, and the plugin's id. A tab labelled with
 * the second one is the claim; a tab labelled with the third is the defect.
 */
const NAMED_PANEL_LABEL = /^Tab Panel$/;
const NAMED_PLUGIN_LABEL = /^Named Plugin$/;
const NAMED_PLUGIN_ID_LABEL = /^demo-named$/;
/**
 * The same label at the START of a card's accessible name.
 *
 * A card's name is `<label> <description>`, and the description is the plugin's own
 * `Panel.description` (S22). A loose substring match would find a title inside another card's
 * description and make a negative assertion below meaningless, so the label is anchored at the
 * start and must end at a word boundary.
 */
const cardName = (label: RegExp): RegExp =>
  // `(?= |$)` and not `\b`: JavaScript's word boundary is ASCII-only, so it never fires after «и».
  new RegExp(`^(?:${label.source.replace(/^\^|\$$/g, "")})(?= |$)`);

/** `PanelLayoutControls.tsx` — the app's own right-panel toggle. */
const RIGHT_PANEL_TOGGLE = /^(Переключить правую панель|Toggle right panel)/;
/** `RightPanelTabs.tsx` `RightPanelEmptyState` — the launcher, when the panel has no surfaces. */
const launcher = (page: Page) => page.locator("[data-surface-launcher-keys]");
const tabList = (page: Page) => page.locator("[data-right-panel-tab-list]");
const panelBody = (page: Page) => page.locator("[data-right-panel-surface-content]");
const catalogsRoot = (page: Page) => panelBody(page).locator('[data-plugin-root="catalogs"]');
/** The wrapped catalog UI's own three tabs — the proof the PANEL, not a placeholder, is mounted. */
const catalogInnerTab = (page: Page) =>
  page.getByRole("tab", { name: /^(Каталог|Catalog)$/ }).first();

/**
 * The text of something that may not be there.
 *
 * `count()` FIRST, and never a bare `innerText()`: on a locator that matches nothing `innerText()`
 * does not answer "", it waits for the element for the full action timeout — and after the last
 * tab closes the right panel is GONE, which is precisely the state the evidence below is taken in.
 * (`fixtures.ts` `commandMenuText` carries the same rule for the composer menu, for the same
 * reason: it cost this spec a 3-minute timeout on a case whose assertions had all passed.)
 */
const textOf = async (locator: ReturnType<typeof launcher>): Promise<string> => {
  if ((await locator.count()) === 0) return "(not on screen)";
  return await locator.innerText({ timeout: 5_000 }).catch(() => "(unreadable)");
};

const dismissToasts = async (page: Page): Promise<void> => {
  const closers = page.locator('[data-slot="toast-close"]');
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await closers.count()) === 0) return;
    await closers
      .first()
      .dispatchEvent("click", { timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(300);
  }
};

/**
 * Start every case from a right panel with NO surfaces.
 *
 * `rightPanelStore` is PERSISTED per thread (`ruCode:right-panel-state:v2`) and this suite shares
 * one app and one storage state across its cases, so a tab the previous case opened would still be
 * there and the launcher — which only draws when the panel is empty — would never appear. Cleared
 * once, from the page, rather than with an `addInitScript`: the per-thread case below navigates
 * back to a thread and needs its tab to SURVIVE that navigation, which an init script that ran on
 * every load would take away.
 */
const forgetOpenSurfaces = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.includes("right-panel-state")) window.localStorage.removeItem(key);
    }
  });
};

/**
 * Open a chat with the plugins loaded and an empty right panel.
 *
 * NO connection wait, deliberately — and it is the one thing this suite does not need. Every claim
 * here is about WHERE a panel is mounted, and the chrome that answers it (the launcher card, the
 * tab, the plugin root, the wrapped panel's own tab strip, the demo's `data-testid`) renders from
 * the seam, not from data. The suite's usual `openDemoPanel` predicate costs a minute per case and
 * would only be proving the transport, which `catalogs.e2e.test.ts` already does.
 */
const openPluginChat = async (page: Page): Promise<void> => {
  await openChat(page);
  await forgetOpenSurfaces(page);
  // …and load it again, so the app reads the cleared state rather than re-persisting what it held.
  await openChat(page);
  await dismissToasts(page);
};

/** Show the thread's right panel with nothing in it, which is what draws the launcher. */
const openEmptyRightPanel = async (page: Page): Promise<void> => {
  if (
    await launcher(page)
      .isVisible()
      .catch(() => false)
  )
    return;
  const toggle = page.getByRole("button", { name: RIGHT_PANEL_TOGGLE }).first();
  await expect(toggle, "the app's right-panel toggle").toBeVisible({ timeout: 30_000 });
  await toggle.dispatchEvent("click", { timeout: 15_000 });
  await expect(launcher(page), "the launcher, with no surface open yet").toBeVisible({
    timeout: 30_000,
  });
};

/** A launcher card, by the label the plugin gave its panel. */
const card = (page: Page, label: RegExp) =>
  launcher(page)
    .getByRole("button", { name: cardName(label) })
    .first();

/**
 * Click a card.
 *
 * A REAL pointer click first — that the card is reachable is part of the claim — BOUNDED, with the
 * suite's established `dispatchEvent` fallback: the app's toast viewport renders over this area and
 * this harness always has one on screen (the `demo-broken` fixture's failure toast arrives seconds
 * after load), and Playwright's default action timeout is "wait forever", which turns an
 * intercepted click into a hung spec rather than a failed one. `fixtures.ts` documents the same
 * trade for the footer icon and the demo panel's own controls.
 */
const clickCard = async (page: Page, label: RegExp): Promise<void> => {
  const target = card(page, label);
  await expect(target, `the ${String(label)} card`).toBeVisible({ timeout: 30_000 });
  const clicked = await target
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await target.dispatchEvent("click", { timeout: 15_000 });
};

/** A tab in the strip, by its title — NOT its ✕, whose name is `Close <title>`. */
const tab = (page: Page, label: RegExp) => tabList(page).getByRole("button", { name: label });

/** The sidebar rail's footer, where both nav families live (`SidebarChrome.tsx`). */
const footer = (page: Page) => page.locator('[data-sidebar="footer"]');

/** Click a footer rail entry (the plugin's `nav`). */
const clickFooterEntry = async (page: Page, label: RegExp): Promise<void> => {
  const button = footer(page).getByRole("button", { name: label }).first();
  await expect(button, `the footer entry ${String(label)}`).toBeVisible({ timeout: 30_000 });
  await button.dispatchEvent("click", { timeout: 15_000 });
};

/**
 * The suite's plugin tree is SHARED, and two cases below take it apart.
 *
 * `globalSetup` builds one tree and one app for the whole file set, `workers: 1`, and five specs run
 * after this one. A case that removes `demo` or drops a fixture in and then puts things back at the
 * END OF ITS BODY only puts them back when its body reaches the end: a failed assertion, a timeout
 * or a Ctrl-C leaves the next five specs looking at a tree nobody built, and they fail naming
 * something that is not wrong (S15 C1). So the restore is registered rather than written down —
 * `afterEach` runs on the way out of a case however the case ended.
 *
 * ONE backup, taken before the first removal and reused: both cases want the same bytes back, and a
 * second copy taken after a removal would copy nothing.
 */
const demoBackupDir = (running: PluginsHarnessState): string =>
  NodePath.join(running.tmpRoot, "plugins-suite-demo-backup");

const backUpDemoFolder = (running: PluginsHarnessState): string => {
  const backup = demoBackupDir(running);
  if (!NodeFS.existsSync(backup)) {
    NodeFS.cpSync(NodePath.join(running.pluginsDir, DEMO_ID), backup, { recursive: true });
  }
  return backup;
};

/** Is the harness's app still up? `kill(pid, 0)` asks without signalling anything. */
const processAlive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Put the tree back the way `globalSetup` built it — and do nothing at all when it already is.
 *
 * IDEMPOTENT on purpose: it runs after every case in this file, including the five that touch
 * nothing and the two that already restored themselves inside their own claim. The three checks are
 * cheap (two `existsSync` and a signal-less `kill`), and the expensive half — a stop and a restart —
 * only happens when something is actually out of place. The app itself is part of "in place": a
 * case aborted between `stopPluginsApp` and `restartPluginsApp` leaves the tree right and the app
 * down, which is the same five reds by another route.
 */
const restoreSuiteTree = async (): Promise<void> => {
  const running = state();
  const demoMissing = !NodeFS.existsSync(NodePath.join(running.pluginsDir, DEMO_ID));
  const namedPresent = NodeFS.existsSync(NodePath.join(running.pluginsDir, DEMO_NAMED_ID));
  const appDown = !processAlive(running.runnerPid);
  if (!demoMissing && !namedPresent && !appDown) return;

  await stopPluginsApp(running);
  const backup = demoBackupDir(running);
  if (demoMissing && NodeFS.existsSync(backup)) {
    installPluginFolder(running.pluginsDir, DEMO_ID, backup);
  }
  if (namedPresent) removePluginFolder(running.pluginsDir, DEMO_NAMED_ID);
  await restartPluginsApp(running);
};

test.describe("plugins — panels mounted as TABS of the thread right panel", () => {
  test.afterEach(async () => {
    await restoreSuiteTree();
  });

  test("the launcher offers the TAB-mounted panels, and not the global one", async ({ page }) => {
    test.setTimeout(180_000);
    await openPluginChat(page);
    await openEmptyRightPanel(page);

    // (a) `catalogs` declares skills + agents as tabs and commands as a global panel, so the
    // launcher shows exactly the first two — the host filtered nothing by name, it read `mount`.
    await expect(card(page, SKILLS_LABEL), "the Skills card").toBeVisible({ timeout: 30_000 });
    await expect(card(page, AGENTS_LABEL), "the Agents card").toBeVisible();
    await expect(card(page, DEMO_TAB_LABEL), "the demo's tab card").toBeVisible();
    expect(
      await launcher(page)
        .getByRole("button", { name: cardName(COMMANDS_LABEL) })
        .count(),
      "Commands is a GLOBAL panel and must not be a card",
    ).toBe(0);
    // The app's own cards are still there, with their letter shortcuts; a contributed card has
    // none (`RightPanelTabs.tsx`: the letters are a fixed table).
    const shortcutKeys = (await launcher(page).getAttribute("data-surface-launcher-keys")) ?? "";
    expect(shortcutKeys, "the app's own letters are unchanged").toContain("F");
    // S22: the line under a card is the PLUGIN's `Panel.description`, in the plugin's own words
    // and locale — never the manifest name («Skills, Agents & Commands») the host used to print.
    await expect(
      card(page, SKILLS_LABEL),
      "the Skills card carries its own description",
    ).toContainText(SKILLS_DESCRIPTION);
    await expect(card(page, DEMO_TAB_LABEL)).toContainText(DEMO_TAB_DESCRIPTION);
    expect(await launcher(page).innerText(), "and not the manifest name").not.toMatch(
      /Skills, Agents & Commands/,
    );

    await saveEvidenceScreenshot(page, "plugin-tabs-launcher");
    saveEvidenceJson("plugin-tabs-launcher", {
      spec: "pluginTabs.e2e.test.ts",
      shortcutKeys,
      cards: await textOf(launcher(page)),
    });
  });

  test('the tab strip\'s "+" menu lists the TAB-mounted panels too, and opens or focuses them (S22)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openPluginChat(page);
    await openEmptyRightPanel(page);
    // The "+" menu exists only once the strip has a surface: open the app's own Files tab first.
    // An app card's accessible name starts with its shortcut letter (`<Kbd>F</Kbd>`), hence `F `.
    const filesCard = launcher(page)
      .getByRole("button", { name: /^F (Files|Файлы)(?= |$)/ })
      .first();
    await expect(filesCard, "the app's own Files card").toBeVisible({ timeout: 30_000 });
    await filesCard.dispatchEvent("click", { timeout: 15_000 });
    const plus = page.getByRole("button", { name: /^(Add panel surface|Добавить панель)/ }).first();
    await expect(plus, 'the strip\'s "+" button').toBeVisible({ timeout: 30_000 });
    await plus.dispatchEvent("click", { timeout: 15_000 });
    const menu = page.getByRole("menu").first();
    await expect(menu, 'the "+" menu').toBeVisible({ timeout: 15_000 });
    // (a) the two catalogs TABS and the demo tab are entries — after the app's own six, from the
    // same runner the launcher cards use; the GLOBAL commands panel is not.
    const entry = (label: RegExp) => menu.getByRole("menuitem", { name: cardName(label) }).first();
    await expect(entry(SKILLS_LABEL), "the Skills entry").toBeVisible();
    await expect(entry(AGENTS_LABEL), "the Agents entry").toBeVisible();
    await expect(entry(DEMO_TAB_LABEL), "the demo's tab entry").toBeVisible();
    expect(await menu.getByRole("menuitem", { name: cardName(COMMANDS_LABEL) }).count()).toBe(0);
    // …each with the plugin's own description under it (S22).
    await expect(entry(SKILLS_LABEL)).toContainText(SKILLS_DESCRIPTION);
    const menuText = await menu.innerText();
    await saveEvidenceScreenshot(page, "plugin-tabs-plus-menu");

    // (b) selecting Agents opens it as a tab, exactly like the card…
    await entry(AGENTS_LABEL).dispatchEvent("click", { timeout: 15_000 });
    await expect(tab(page, AGENTS_LABEL), "the tab is in the strip").toBeVisible({
      timeout: 30_000,
    });
    await expect(catalogInnerTab(page), "with the plugin's real body").toBeVisible({
      timeout: 30_000,
    });
    // (c) …and selecting it again FOCUSES the tab it already has: still one, still on screen.
    await tab(page, /^(Files|Файлы)$/).dispatchEvent("click", { timeout: 15_000 });
    await plus.dispatchEvent("click", { timeout: 15_000 });
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await entry(AGENTS_LABEL).dispatchEvent("click", { timeout: 15_000 });
    expect(await tab(page, AGENTS_LABEL).count(), "still ONE Agents tab").toBe(1);
    await expect(catalogInnerTab(page), "and it is the one on screen again").toBeVisible({
      timeout: 30_000,
    });

    saveEvidenceJson("plugin-tabs-plus-menu", {
      spec: "pluginTabs.e2e.test.ts",
      menu: menuText,
      tabs: await textOf(tabList(page)),
    });
  });

  test("a card opens the panel as a tab, inside the plugin's own CSS scope", async ({ page }) => {
    test.setTimeout(180_000);
    await openPluginChat(page);
    await openEmptyRightPanel(page);

    // (b) the card opens it…
    await clickCard(page, AGENTS_LABEL);
    await expect(tab(page, AGENTS_LABEL), "the tab is in the strip").toBeVisible({
      timeout: 30_000,
    });
    // …and the BODY is the plugin's real panel: the wrapped catalog UI's own tabs, inside
    // `[data-plugin-root="catalogs"]` (V2-14 — the scope the SDK nests the plugin's sheet under).
    await expect(catalogsRoot(page), "the body is inside the plugin root").toBeVisible({
      timeout: 30_000,
    });
    await expect(catalogInnerTab(page), "the wrapped panel's own tabs").toBeVisible({
      timeout: 30_000,
    });
    expect(
      await catalogsRoot(page)
        .locator("xpath=ancestor::*[@data-right-panel-surface-content]")
        .count(),
      "the plugin root is inside the right panel's body, not in the global slot",
    ).toBe(1);

    // (c) a SECOND open focuses the tab it already has — from the card's own home, the footer.
    await clickFooterEntry(page, AGENTS_LABEL);
    expect(await tab(page, AGENTS_LABEL).count(), "still ONE Agents tab").toBe(1);
    await expect(catalogInnerTab(page), "and it is still the one on screen").toBeVisible();

    // A second, different tab lands beside it rather than replacing it.
    await clickFooterEntry(page, SKILLS_LABEL);
    await expect(tab(page, SKILLS_LABEL)).toBeVisible({ timeout: 30_000 });
    expect(await tab(page, AGENTS_LABEL).count(), "the first tab is still open").toBe(1);

    await saveEvidenceScreenshot(page, "plugin-tabs-open");
    saveEvidenceJson("plugin-tabs-open", {
      spec: "pluginTabs.e2e.test.ts",
      tabs: await textOf(tabList(page)),
    });
  });

  test("the tab closes from its ✕ and from the plugin's own `ctx.closePanel`", async ({ page }) => {
    test.setTimeout(180_000);
    await openPluginChat(page);
    await openEmptyRightPanel(page);

    // (d1) the app's own ✕ on the tab.
    await clickCard(page, SKILLS_LABEL);
    await expect(tab(page, SKILLS_LABEL)).toBeVisible({ timeout: 30_000 });
    const closeSkills = tabList(page)
      .getByRole("button", { name: /^Close (Менеджер Навыков|Skill manager)$/ })
      .first();
    await closeSkills.dispatchEvent("click", { timeout: 15_000 });
    await expect(tab(page, SKILLS_LABEL), "the ✕ closed it").toHaveCount(0, { timeout: 30_000 });

    // (d2) `ctx.closePanel(id)` — the demo's own header button, the SAME call its global panel
    // makes. The host routes the id to whichever slot that panel is mounted in.
    await openEmptyRightPanel(page);
    await clickCard(page, DEMO_TAB_LABEL);
    const demoTab = page.locator('[data-testid="demo-tab-panel"]');
    await expect(demoTab, "the demo's tab body").toBeVisible({ timeout: 30_000 });
    await page
      .locator('[data-testid="demo-tab-panel-close"]')
      .first()
      .dispatchEvent("click", { timeout: 15_000 });
    await expect(demoTab, "the plugin closed its own tab").toHaveCount(0, { timeout: 30_000 });
    await expect(tab(page, DEMO_TAB_LABEL)).toHaveCount(0);
    // Its GLOBAL panel is untouched by that: a plugin closing one surface keeps the other.
    await expect(
      demoFooterButton(page),
      "the demo's global panel entry is still on the rail",
    ).toBeVisible();

    saveEvidenceJson("plugin-tabs-close", {
      spec: "pluginTabs.e2e.test.ts",
      panelAfterClose: await textOf(panelBody(page)),
    });
  });

  test("the tab belongs to its THREAD: another thread does not have it, coming back does", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openPluginChat(page);
    await openEmptyRightPanel(page);
    await clickCard(page, AGENTS_LABEL);
    await expect(tab(page, AGENTS_LABEL)).toBeVisible({ timeout: 30_000 });
    const withTab = page.url();

    // (e) a different thread — per-thread state, exactly like diff and files (V2-27).
    await page
      .getByRole("button", { name: /New thread|Новый диалог|Новый поток/ })
      .first()
      .dispatchEvent("click", { timeout: 15_000 });
    await expect
      .poll(() => page.url(), { timeout: 30_000, message: "the app moved to another thread" })
      .not.toBe(withTab);
    await expect(tab(page, AGENTS_LABEL), "the other thread has no Agents tab").toHaveCount(0, {
      timeout: 30_000,
    });

    await page.goto(withTab, { waitUntil: "domcontentloaded" });
    await expect(tab(page, AGENTS_LABEL), "and the first thread still has it").toBeVisible({
      timeout: 60_000,
    });
    await expect(catalogInnerTab(page), "with its body restored").toBeVisible({ timeout: 60_000 });

    saveEvidenceJson("plugin-tabs-per-thread", {
      spec: "pluginTabs.e2e.test.ts",
      threadWithTab: withTab,
    });
  });

  test("a panel mounted in the GLOBAL slot still opens there", async ({ page }) => {
    test.setTimeout(180_000);
    await openPluginChat(page);

    // (f) commands declares `mount: "panel"`, so its footer entry opens the app's global right
    // slot — NOT a tab of the thread panel, and not both.
    await clickFooterEntry(page, COMMANDS_LABEL);
    await expect(catalogInnerTab(page), "the commands panel is on screen").toBeVisible({
      timeout: 30_000,
    });
    expect(await tab(page, COMMANDS_LABEL).count(), "and it is not a tab of the thread panel").toBe(
      0,
    );
    // The global slot mounts it in the same plugin scope the tab body uses (V2-14).
    //
    // `:visible`, because a `[data-plugin-root]` is not unique on this page: the host mounts one
    // per rendered seam, and the ones belonging to surfaces that are not on screen stay in the DOM
    // as empty boxes. The claim is about the panel the user is looking at.
    const openRoot = page.locator('[data-plugin-root="catalogs"]:visible').first();
    await expect(openRoot, "the commands panel is inside the plugin's CSS scope").toBeVisible({
      timeout: 30_000,
    });
    expect(
      await openRoot.locator("xpath=ancestor::*[@data-right-panel-surface-content]").count(),
      "the global panel is NOT inside the thread panel's body",
    ).toBe(0);

    await saveEvidenceScreenshot(page, "plugin-tabs-global-panel");
    await clickFooterEntry(page, COMMANDS_LABEL);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // S15 A1/A2 — the reconcile must not delete a tab on the plugin's SILENCE
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  //
  // A tab is a PERSISTED surface of the user's right panel, and the host closes one whose panel is
  // no longer contributed. "No longer contributed" is a claim about a plugin that ANSWERED: the
  // plugin loaded and did not offer that panel. A plugin that is not installed, is disabled, failed
  // to load or threw has said nothing at all, and deleting the user's tab on that is the host
  // guessing — the tab never comes back when the plugin does, because nothing remembers it was
  // there.
  //
  // This case drives exactly that, at the layer a user would: a tab is open, the plugin's folder is
  // deleted under it, the app is restarted — and the tab is still there, empty, labelled with the
  // plugin's own id (all the host still knows). Then the folder comes back, the app is restarted
  // again, and the tab renders its panel again with nothing having been reopened by hand.
  test("a tab whose plugin is GONE survives the restart, and renders again when it returns", async ({
    page,
  }) => {
    // Two whole server boots on top of the browser work.
    test.setTimeout(420_000);

    await openPluginChat(page);
    await openEmptyRightPanel(page);
    await clickCard(page, DEMO_TAB_LABEL);
    await expect(tab(page, DEMO_TAB_LABEL), "the demo's tab is open").toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panelBody(page).locator('[data-testid="demo-tab-panel"]'),
      "with its body mounted",
    ).toBeVisible({ timeout: 30_000 });
    const threadWithTab = page.url();

    // ── the plugin disappears under the open tab ────────────────────────────────────────────────
    const running = state();
    // The shared backup, and the `afterEach` above is the safety net if this case never reaches its
    // own restore below — that restore is part of the CLAIM (the tab comes back), not cleanup.
    const backup = backUpDemoFolder(running);
    await stopPluginsApp(running);
    removePluginFolder(running.pluginsDir, DEMO_ID);
    await restartPluginsApp(running);

    await page.goto(threadWithTab, { waitUntil: "domcontentloaded" });
    await expect(composer(page), "the app came back up").toBeVisible({ timeout: 60_000 });
    // PAST THE LOADER'S WHOLE BUDGET, and this number is load-bearing. The pass is announced only
    // when every plugin has settled, and this harness installs `demo-hang`, whose `activate()`
    // never returns — so the outcome, and the reconcile it licenses, arrive at the 10 s timeout
    // (`PLUGIN_LOAD_TIMEOUT_MS`), not at first paint. Measured: with the fix reverted this same
    // assertion PASSED at 6 s and the tab was deleted four seconds later.
    await page.waitForTimeout(16_000);

    const survivor = tabList(page).getByRole("button", { name: /^demo$/ });
    await expect(
      survivor,
      "the tab is still there, under the only name the host still has — the plugin's id",
    ).toBeVisible({ timeout: 30_000 });
    expect(
      await panelBody(page).locator('[data-testid="demo-tab-panel"]').count(),
      "and its body is empty: the plugin that drew it is not installed",
    ).toBe(0);
    await saveEvidenceScreenshot(page, "plugin-tabs-degraded");

    // ── and it comes back when the plugin does ─────────────────────────────────────────────────
    const restarted = state();
    await stopPluginsApp(restarted);
    installPluginFolder(restarted.pluginsDir, DEMO_ID, backup);
    await restartPluginsApp(restarted);

    await page.goto(threadWithTab, { waitUntil: "domcontentloaded" });
    await expect(composer(page), "the app came back up again").toBeVisible({ timeout: 60_000 });
    await expect(
      tab(page, DEMO_TAB_LABEL),
      "the tab is the plugin's own again, with its title back",
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      panelBody(page).locator('[data-testid="demo-tab-panel"]'),
      "and it renders, without the user having reopened anything",
    ).toBeVisible({ timeout: 60_000 });

    saveEvidenceJson("plugin-tabs-degraded", {
      spec: "pluginTabs.e2e.test.ts",
      thread: threadWithTab,
      claim:
        "a persisted tab is kept while its plugin is absent, and renders again when it returns",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // S15 B1 — the kept tab is labelled with the plugin's NAME, not its id
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  //
  // The case above proves a tab survives its plugin. This one is about the label it survives WITH,
  // and that is a different mechanism: the display name is recorded from `manifests.json` for every
  // row, including rows whose web half then fails to import — and a plugin that fails to import
  // never reaches the registry, so nothing the tab strip watches through `usePlugins()` or the
  // panels seam moves when that name lands. Before S15 B1 the name had no change signal at all and
  // the strip showed the plugin's ID until some unrelated repaint happened along.
  //
  // The fixture is a plugin whose three strings are all different — panel title `Tab Panel`,
  // manifest name `Named Plugin`, id `demo-named` — installed working, opened as a tab, and then
  // given a web entry that throws at module scope while its manifest row stays byte-identical.
  test("a tab whose plugin FAILED to load is labelled with the plugin's NAME (S15 B1)", async ({
    page,
  }) => {
    // Three server boots on top of the browser work.
    test.setTimeout(600_000);

    // ── the plugin works: open its panel as a tab, the ordinary way ────────────────────────────
    const running = state();
    await stopPluginsApp(running);
    installNamedPlugin(running.pluginsDir, { broken: false });
    await restartPluginsApp(running);

    await openPluginChat(page);
    await openEmptyRightPanel(page);
    await clickCard(page, NAMED_PANEL_LABEL);
    await expect(tab(page, NAMED_PANEL_LABEL), "the tab wears the PANEL's title").toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panelBody(page).locator(`[data-plugin-root="${DEMO_NAMED_ID}"]`),
      "and its body is the plugin's",
    ).toBeVisible({ timeout: 30_000 });
    const threadWithNamedTab = page.url();

    // ── the web half breaks; the manifest row, and its name, do not ────────────────────────────
    //
    // `demo` goes with it, and that is what makes the assertion below mean something. The label
    // lands on the strip either because the display name signalled (S15 B1) or because something
    // else repainted the strip after the name was recorded — and in this harness the reliable
    // "something else" is another plugin registering, which re-renders every consumer of
    // `usePlugins()`. With `demo` out, NO plugin registers on this load: `demo-hang` never settles
    // its `activate`, `demo-broken` is refused by the server, and `demo-named`'s module throws. The
    // strip is left with nothing but the name's own subscription.
    const broken = state();
    backUpDemoFolder(broken);
    await stopPluginsApp(broken);
    installNamedPlugin(broken.pluginsDir, { broken: true });
    removePluginFolder(broken.pluginsDir, DEMO_ID);
    await restartPluginsApp(broken);

    await page.goto(threadWithNamedTab, { waitUntil: "domcontentloaded" });
    await expect(composer(page), "the app came back up").toBeVisible({ timeout: 60_000 });
    // Past the loader's whole budget, for the reason the case above states: `demo-hang` holds the
    // pass open for 10 s, and every assertion below is about what the host settles on.
    await page.waitForTimeout(16_000);

    await expect(
      tab(page, NAMED_PLUGIN_LABEL),
      "the strip labels the kept tab with the plugin's manifest NAME",
    ).toBeVisible({ timeout: 30_000 });
    expect(
      await tab(page, NAMED_PLUGIN_ID_LABEL).count(),
      "and never with its id, which is all the host had before the name landed",
    ).toBe(0);
    expect(
      await tab(page, NAMED_PANEL_LABEL).count(),
      "the panel's own title is gone with the panel",
    ).toBe(0);
    expect(
      await panelBody(page).locator(`[data-plugin-root="${DEMO_NAMED_ID}"]`).count(),
      "and the body is the degraded empty surface — the plugin drew nothing this load",
    ).toBe(0);

    await saveEvidenceScreenshot(page, "plugin-tabs-named");
    saveEvidenceJson("plugin-tabs-named", {
      spec: "pluginTabs.e2e.test.ts",
      thread: threadWithNamedTab,
      claim:
        "a kept tab whose plugin failed to import is labelled with the manifest name, not the id",
    });

    // The tree goes back through `afterEach` — including when this case never gets here.
  });
});
