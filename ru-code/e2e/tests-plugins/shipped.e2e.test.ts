// ru-code (V2-20 / V2-21) — spec 12: the SHIPPED plugin set, in a real browser.
//
// Every other spec in this suite drives plugins the way a USER installs them: a folder dropped into
// `<baseDir>/plugins`. This one drives the other channel — the set a RELEASE carries inside its
// version payload — and it is the acceptance for the whole of S6: after an install or an update,
// the features that were removed from the app (the analytics page, the catalog panels) are present
// with no user action at all, out of a directory the user never touched.
//
// HOW THE PAYLOAD IS SIMULATED. `RU_CODE_SHIPPED_PLUGINS_DIR` (test-only, documented beside
// `RU_CODE_PLUGINS_DIR` in `paths.ts`) points the loader's first root at a payload-shaped
// `…/plugins/<id>` tree the harness COPIES each `dist/` into — exactly what `pnpm stage:plugins`
// does, and what `prepare-release` then lands at `versions/<v>/plugins/<id>`. Building, packing and
// installing a real release for one spec would add minutes and a second class of failure to a suite
// whose job is the browser; the install and update channels themselves are pinned in the sandboxed
// suites (`tests/install/shippedPlugins.test.ts`, `tests/auto-update/shippedPlugins.test.ts`) where
// they can be driven for real and cheaply.
//
// AND THE USER DIR IS EMPTIED FIRST. `pluginsBoot` seeds analytics and catalogs as USER plugins for
// the other specs; here they must be absent, or "the shipped root supplied it" would be
// unfalsifiable. The spec removes them, restarts, and puts the tree back exactly as the boot built
// it in `afterAll` — `shipped.e2e.test.ts` sorts before `styles` and `uninstall`, both of which
// count footer icons and manifest rows.
//
// WHAT IT PINS, in order:
//
//   1. both shipped plugins are `loaded` while NEITHER has a folder in the user dir;
//   2. the analytics PAGE renders on its host-owned route, and its migrations ran against a data
//      folder the harness deleted first — so the shipped copy did the work, not a leftover;
//   3. the catalogs panels open — the plugin's own registrations, from the payload;
//   4. a COLLISION: a user copy of `catalogs` beside the shipped one leaves exactly one row, and
//      the bytes the browser is served are the SHIPPED file's, not the user's;
//   5. the OPT-OUT: `disabled.json` naming `analytics` makes it `skipped` with the operator's
//      reason, removes its nav entry, and leaves catalogs `loaded`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  removeOptionalPlugins,
  restartPluginsApp,
  seedOptionalPlugins,
  stageShippedPluginsFixture,
  stopPluginsApp,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

import {
  expect,
  fetchManifests,
  openAppWithDemo,
  openChat,
  state,
  statusOf,
  test,
} from "./fixtures.ts";

const ANALYTICS_ID = "analytics";
const CATALOGS_ID = "catalogs";
/** `ANALYTICS_PAGE_ID` in `plugin-analytics/src/web/index.tsx`. */
const ANALYTICS_PAGE_PATH = `/plugins/${ANALYTICS_ID}/dashboard`;

/** Locale-agnostic: this suite switches the app's language (see `fixtures.ts`). */
const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const AGENTS_LABEL = /^(Менеджер Агентов|Agent manager)$/;
const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
const CATALOG_TAB = /^(Каталог|Catalog)$/;

const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The marker appended to the USER copy's web entry in the collision case.
 *
 * A trailing line comment: valid JS, so the user copy is a perfectly loadable plugin and the spec
 * is about PRECEDENCE rather than about one of the two being broken. It is also what makes the byte
 * comparison mean something — two identical copies would make "served the shipped one" vacuous.
 */
const USER_COPY_MARKER = "\n// e2e: this is the USER copy, which must never be served\n";

/** The shipped root this run stages, and the ids that actually made it in. */
let shipped: { readonly dir: string; readonly ids: ReadonlyArray<string> };

/** `<stateDir>/plugins/disabled.json` — the operator's opt-out, outside both plugin roots. */
const disabledListPath = (): string => NodePath.join(state().stateDir, "plugins", "disabled.json");

const writeDisabledList = (ids: ReadonlyArray<string>): void => {
  const file = disabledListPath();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify({ disabled: ids }, null, 2)}\n`, "utf8");
};

const removeDisabledList = (): void => NodeFS.rmSync(disabledListPath(), { force: true });

/** The plugin's own `_plugin_migrations` rows (D2) — empty when it has no database yet. */
async function pluginMigrations(id: string): Promise<ReadonlyArray<string>> {
  const file = NodePath.join(state().stateDir, "plugins", id, "data.sqlite");
  if (!NodeFS.existsSync(file)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT id FROM _plugin_migrations ORDER BY id")
      .all()
      .map((row) => String((row as { id: unknown }).id));
  } catch {
    // No migrations table at all is a legitimate answer for a plugin that declares none.
    return [];
  } finally {
    database.close();
  }
}

const bodyOf = async (path: string): Promise<string> => {
  const response = await fetch(`${state().webUrl}${path}`);
  if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
  return await response.text();
};

test.describe("plugins — the set that SHIPS with the app (V2-20/V2-21)", () => {
  // Four full server restarts across the file, plus two page loads that mount real plugin React.
  test.setTimeout(300_000);

  test.beforeAll(async () => {
    const current = state();
    shipped = stageShippedPluginsFixture(current.tmpRoot);
    if (shipped.ids.length < 2) {
      throw new Error(
        `[plugins-e2e] this spec needs BOTH plugin packages built; staged: ${shipped.ids.join(", ") || "(none)"}\n` +
          `[plugins-e2e] run, in the ru-code-packages worktree: ` +
          `pnpm --filter @smart-tools/plugin-analytics build && pnpm --filter @smart-tools/plugin-catalogs build`,
      );
    }
    await stopPluginsApp(current);
    // The premise: neither plugin is a USER plugin any more, so anything that loads came from the
    // payload. And the analytics DATA folder goes too — its migrations must be proved to have run
    // here, not to have been left behind by `analytics.e2e.test.ts` earlier in the run.
    removeOptionalPlugins(current.pluginsDir);
    removeDisabledList();
    NodeFS.rmSync(NodePath.join(current.stateDir, "plugins", ANALYTICS_ID), {
      recursive: true,
      force: true,
    });
    await restartPluginsApp({ ...current, shippedPluginsDir: shipped.dir });
  });

  test.afterAll(async () => {
    // Put the shared app back exactly as `pluginsBoot` built it: no shipped root, no opt-out list,
    // both plugins seeded as user plugins again. Six specs sort after this file.
    const current = state();
    await stopPluginsApp(current);
    removeDisabledList();
    removeOptionalPlugins(current.pluginsDir);
    seedOptionalPlugins(current.pluginsDir, current.stateDir);
    const { shippedPluginsDir: _dropped, ...withoutShippedRoot } = current;
    await restartPluginsApp(withoutShippedRoot);
  });

  test("both shipped plugins load out of the payload with an EMPTY user plugins dir", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);

    // ── 1. the premise, on disk ──────────────────────────────────────────────────────────────
    const userDir = state().pluginsDir;
    for (const id of [ANALYTICS_ID, CATALOGS_ID]) {
      expect(
        NodeFS.existsSync(NodePath.join(userDir, id)),
        `${id} is NOT a user plugin in this run`,
      ).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(shipped.dir, id, "plugin.json")),
        `${id} IS in the shipped root`,
      ).toBe(true);
    }

    // ── 2. …and both are loaded ──────────────────────────────────────────────────────────────
    const manifests = await fetchManifests();
    for (const id of [ANALYTICS_ID, CATALOGS_ID]) {
      const rows = manifests.filter((entry) => entry.id === id);
      expect(rows, `exactly one manifest row for ${id}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, state: "loaded", hasWeb: true, hasServer: true });
    }
    // The demo plugin is still a USER plugin: the two roots coexist, they do not replace each other.
    expect(manifests.find((entry) => entry.id === "demo")?.state).toBe("loaded");
    // The asset route serves the payload's files through the unchanged `/plugins/<id>/…` route.
    expect(await statusOf(`/plugins/${ANALYTICS_ID}/web/index.mjs`)).toBe(200);
    expect(await statusOf(`/plugins/${CATALOGS_ID}/web/index.mjs`)).toBe(200);

    // ── 3. the analytics PAGE, from the payload ──────────────────────────────────────────────
    await openAppWithDemo(page);
    const analyticsButton = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
    await expect(analyticsButton, "the shipped plugin's footer entry").toBeVisible({
      timeout: 30_000,
    });
    await analyticsButton.click();
    await expect(page.locator('[data-testid="analytics-page"]')).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).pathname).toBe(ANALYTICS_PAGE_PATH);
    await saveEvidenceScreenshot(page, "12-shipped-analytics-page");

    // ── 4. its migrations ran, against a data folder that did not exist at boot ──────────────
    //
    // The host opens a server plugin's storage eagerly and migrates before `activate`, so a row in
    // this table is proof the SHIPPED copy was activated — not that a folder survived from an
    // earlier spec (beforeAll deleted it).
    const migrations = await pluginMigrations(ANALYTICS_ID);
    expect(migrations, "the shipped analytics plugin migrated its own database").toContain(
      "001-file-cache",
    );
    expect(
      NodeFS.existsSync(NodePath.join(state().stateDir, "plugins", ANALYTICS_ID, "data.sqlite")),
    ).toBe(true);

    // ── 5. the catalog panels, from the payload ──────────────────────────────────────────────
    //
    // Counted from the threads, not from the plugin page: since S22 a plugin page's footer is the
    // Back button (`footerPage.ts`), so the rail's entries are asserted where the rail is.
    await openAppWithDemo(page);
    for (const label of [SKILLS_LABEL, AGENTS_LABEL, COMMANDS_LABEL]) {
      expect(
        await page.getByRole("button", { name: label }).count(),
        `exactly one footer entry for ${String(label)}`,
      ).toBe(1);
    }
    await page.getByRole("button", { name: ANALYTICS_LABEL }).first().click();
    await expect(page.locator('[data-testid="analytics-page"]')).toBeVisible({ timeout: 60_000 });
    // BOTH HOMES, from the payload (V2-27). The shipped catalogs plugin puts `commands` in the
    // app's GLOBAL right slot and `skills` / `agents` in the THREAD's right panel as tabs, so a run
    // that only opened one of them would stop proving half of what the payload ships. Each is
    // asserted where it lives, and both are the SAME plugin folder inside the release payload.

    // ── 5a. the GLOBAL slot ─────────────────────────────────────────────────────────────────
    //
    // `RightGlobalPanelHost` is mounted in `AppSidebarLayout`, so the global slot exists on every
    // route. Since S22 a plugin PAGE collapses the footer rail to Back (`footerPage.ts`), so the
    // catalog entries are not on the page this spec has been standing on since step 3: press Back
    // — the same Back `/usage` has — and open the global panel from the threads.
    const back = page.getByRole("button", { name: /^(Назад|Back)$/ }).first();
    await expect(back, "a plugin page shows the footer Back (S22)").toBeVisible({
      timeout: 30_000,
    });
    await back.dispatchEvent("click", { timeout: 15_000 });
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .not.toBe(ANALYTICS_PAGE_PATH);
    const commands = page.getByRole("button", { name: COMMANDS_LABEL }).first();
    await expect(commands, "the shipped plugin's global entry").toBeVisible({ timeout: 30_000 });
    const commandsClicked = await commands
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!commandsClicked) await commands.dispatchEvent("click", { timeout: 15_000 });
    await expect(
      page.getByRole("tab", { name: CATALOG_TAB }).first(),
      "the shipped catalogs plugin's panel opens in the global slot",
    ).toBeVisible({ timeout: 60_000 });
    expect(
      await page
        .locator('[data-right-panel-surface-content] [data-plugin-root="catalogs"]')
        .count(),
      "…and the global slot is NOT the thread panel's body",
    ).toBe(0);
    await saveEvidenceScreenshot(page, "12-shipped-catalogs-panel");
    // Close it again (the footer entry is a toggle for a global panel), so the tab below opens
    // into a right-hand slot nothing else is holding.
    await commands.dispatchEvent("click", { timeout: 15_000 });
    await expect(page.getByRole("tab", { name: CATALOG_TAB })).toHaveCount(0, { timeout: 30_000 });

    // ── 5b. the THREAD TAB (V2-27) ───────────────────────────────────────────────────────────
    //
    // A tab opens on the thread the user is looking at, so its footer entry is DISABLED on a page
    // with no thread panel — which is what this spec was standing on, and what the run that caught
    // this shows: `button "Навыки" [disabled]` beside an enabled `button "Команды"`. On a chat it
    // is live, and the body it mounts is the payload's own surface, in that plugin's CSS scope.
    await openChat(page);
    const skills = page.getByRole("button", { name: SKILLS_LABEL }).first();
    await expect(skills, "the shipped plugin's tab entry is enabled on a thread").toBeEnabled({
      timeout: 30_000,
    });
    const skillsClicked = await skills
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!skillsClicked) await skills.dispatchEvent("click", { timeout: 15_000 });
    await expect(
      page.getByRole("tab", { name: CATALOG_TAB }).first(),
      "the shipped catalogs plugin's panel opens as a thread tab",
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator('[data-right-panel-surface-content] [data-plugin-root="catalogs"]'),
      "…inside the thread panel's body, in the shipped plugin's own CSS scope",
    ).toBeVisible({ timeout: 30_000 });
    await saveEvidenceScreenshot(page, "12-shipped-catalogs-tab");

    saveEvidenceJson("shipped-plugins", {
      spec: "shipped.e2e.test.ts",
      shippedRoot: shipped.dir,
      shippedIds: [...shipped.ids],
      userPluginsDir: userDir,
      userPluginFolders: NodeFS.readdirSync(userDir).sort(),
      manifests,
      analyticsMigrations: migrations,
    });
  });

  test("a user copy of the same id is shadowed: one row, and the SHIPPED bytes are served", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    const current = state();
    const userCopy = NodePath.join(current.pluginsDir, CATALOGS_ID);
    const shippedEntry = NodePath.join(shipped.dir, CATALOGS_ID, "web", "index.mjs");

    // A complete, LOADABLE user copy — plus one marker line, so "which one was served" is a fact
    // about bytes rather than an inference.
    await stopPluginsApp(current);
    NodeFS.rmSync(userCopy, { recursive: true, force: true });
    NodeFS.cpSync(NodePath.join(shipped.dir, CATALOGS_ID), userCopy, {
      recursive: true,
      dereference: true,
    });
    const userEntry = NodePath.join(userCopy, "web", "index.mjs");
    NodeFS.appendFileSync(userEntry, USER_COPY_MARKER, "utf8");
    await restartPluginsApp({ ...current, shippedPluginsDir: shipped.dir });

    const manifests = await fetchManifests();
    expect(
      manifests.filter((entry) => entry.id === CATALOGS_ID),
      "one id, one row — manifests.json is keyed by id",
    ).toHaveLength(1);
    expect(manifests.find((entry) => entry.id === CATALOGS_ID)?.state).toBe("loaded");

    // THE PROOF: the browser is handed the payload's file, byte for byte.
    const served = await bodyOf(`/plugins/${CATALOGS_ID}/web/index.mjs`);
    expect(served, "the served entry is the SHIPPED file").toBe(
      NodeFS.readFileSync(shippedEntry, "utf8"),
    );
    expect(served, "…and not the user's copy").not.toContain("this is the USER copy");
    // D11: the shadowed folder is left exactly where its owner put it.
    expect(NodeFS.existsSync(userEntry), "the user's folder is untouched on disk").toBe(true);
    expect(NodeFS.readFileSync(userEntry, "utf8")).toContain("this is the USER copy");

    // And the app still works: one set of catalog footer entries, not two.
    await openAppWithDemo(page);
    for (const label of [SKILLS_LABEL, AGENTS_LABEL, COMMANDS_LABEL]) {
      expect(await page.getByRole("button", { name: label }).count()).toBe(1);
    }

    saveEvidenceJson("shipped-collision", {
      spec: "shipped.e2e.test.ts",
      shippedEntry,
      userEntry,
      servedBytes: served.length,
      shippedBytes: NodeFS.statSync(shippedEntry).size,
      userBytes: NodeFS.statSync(userEntry).size,
      manifests,
    });
  });

  test("disabled.json switches a SHIPPED plugin off: skipped, no nav entry, neighbours intact", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    const current = state();
    await stopPluginsApp(current);
    writeDisabledList([ANALYTICS_ID]);
    await restartPluginsApp({ ...current, shippedPluginsDir: shipped.dir });

    const manifests = await fetchManifests();
    const analytics = manifests.find((entry) => entry.id === ANALYTICS_ID);
    expect(analytics).toMatchObject({
      id: ANALYTICS_ID,
      state: "skipped",
      error: "disabled by the operator",
    });
    // A skipped plugin advertises nothing the browser could fetch, and its assets 404.
    expect(analytics?.hasWeb).toBe(false);
    expect(await statusOf(`/plugins/${ANALYTICS_ID}/web/index.mjs`)).toBe(404);
    // The opt-out is per id: its neighbour in the same root is untouched.
    expect(manifests.find((entry) => entry.id === CATALOGS_ID)?.state).toBe("loaded");

    await openAppWithDemo(page);
    expect(
      await page.getByRole("button", { name: ANALYTICS_LABEL }).count(),
      "no footer entry for a disabled plugin",
    ).toBe(0);
    expect(
      await page.getByRole("button", { name: SKILLS_LABEL }).count(),
      "…while the catalogs entries are still there",
    ).toBe(1);
    await saveEvidenceScreenshot(page, "12-shipped-disabled");

    // Its DATA is untouched by the opt-out — the list is reversible, not an uninstall.
    expect(
      NodeFS.existsSync(NodePath.join(current.stateDir, "plugins", ANALYTICS_ID, "data.sqlite")),
      "the disabled plugin's data survives",
    ).toBe(true);

    saveEvidenceJson("shipped-disabled", {
      spec: "shipped.e2e.test.ts",
      disabledList: disabledListPath(),
      manifests,
    });
  });
});
