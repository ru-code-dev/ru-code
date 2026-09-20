// ru-code v2 — the CATALOGS plugin, end to end in a real browser.
//
// `@smart-tools/plugin-catalogs` is the port that carries the app's three catalog panels, its three
// composer menus and its spawn-path behaviour into a dropped-in folder. Six claims, in the order a
// user meets them:
//
//  0. WHERE THEY LIVE (V2-27): skills and agents are TABS of the thread's right panel, commands is
//     the app's GLOBAL right slot. The footer entry opens either; only closing differs, which is
//     what `closeCatalogPanel` below carries. The tab mechanism itself is
//     `tests-plugins/pluginTabs.e2e.test.ts`.
//  1. THREE FOOTER ENTRIES, THREE PANELS. `panels` returns skills / agents / commands with lucide
//     NAMES, and each panel's body is the wrapped packages' own three-tab `ItemsPanel` showing the
//     item seeded on disk. This is also the ATOM proof in a browser: the panels read
//     `catalogDataAtom` out of the PLUGIN's own registry (`src/web/registry.tsx`) because
//     `@effect/atom-react` is bundled now — get that wrong and every panel renders its empty state
//     with no error anywhere, which is exactly what this spec would catch.
//  2. THE THREE MENUS. `$` lists the skill, `#` the agent (plus qwen's two built-ins), `/` the
//     command — one `composer.items` seam for all three.
//  3. THE INSERTED BYTES. `insert` is pasted VERBATIM in v2, so the plugin owns the trailing space:
//     `skill:⟦name⟧ `, `agent:⟦name⟧ `, `/name ` — one 0x20, never two. Read off the app's own draft
//     store, because the composer renders the token as a CHIP and `innerText` would show the label.
//  4. THE BACKGROUND RESYNC, AND WHAT IT COSTS (V2-41, S38). The reconcile still runs on the ready
//     flip and on a project-set change — no FS watcher, no polling, the rule the app's
//     `CatalogAutoResync` had — but the SERVER now walks the disk once per process per project-root
//     set and answers every later reconcile from its reconciled store. So a file written on disk
//     BEHIND the app's back is brought in by the panel's own Refresh (which always walks), not by
//     opening another page; that is the owner's decision, and this file pins both halves of it.
//  4b. CROSS-TAB (S53, V2-54; S69, V2-58). A change one tab makes reaches every other tab with no
//     reload: the server half publishes the catalog's store after every operation that may have
//     changed it, and the host keeps the value current in every tab. This is the owner's own case
//     from `WORKFLOW/queue/notify-seam.md`.
//  5. THE RESPAWN. qwen reads skills/subagents/commands only at spawn, so a catalog change between
//     two turns must restart the provider session. Pinned on the FAKE ACP's own log (a new process
//     logging `session/new`), not on the app's UI.
//  6. UNINSTALL. Delete the folder, restart: no footer entries, no rows, and a catalog change no
//     longer respawns anything. Then the folder is restored, so the rest of the suite is unaffected.
//
// SEEDING. The harness creates `<home>/.qwen` before the server starts and publishes it as
// `state().cliConfigDir`, so this spec writes the CLI tree itself — the shapes come from the
// packages' own scanners (`<root>/.qwen/skills/<name>/SKILL.md`, `<root>/.qwen/agents/<x>.md`,
// `<root>/.qwen/commands/<path>.toml`). Nothing in the harness had to change. The tree is removed
// again in `afterAll`, so a later spec in the shared app sees the catalogs empty, as it did before.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  clearComposer,
  closeDemoPanel,
  commandMenu,
  commandMenuText,
  composer,
  expect,
  fetchManifests,
  focusComposer,
  openChat,
  openDemoPanel,
  state,
  statusOf,
  test,
  typeTrigger,
  type Page,
} from "./fixtures.ts";
import {
  PLUGINS_ARTIFACTS_DIR,
  installPluginFolder,
  removePluginFolder,
  restartPluginsApp,
  stopPluginsApp,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const CATALOGS_ID = "catalogs";
const CATALOGS_DIST = NodePath.resolve(
  import.meta.dirname,
  "../../../ru-code-packages/packages/plugin-catalogs/dist",
);

/** The three seeded items, and the display names the wrapped UI formats them into. */
const SKILL = { name: "e2e-skill", label: "E2e Skill", description: "The e2e seeded skill." };
const AGENT = { name: "e2e-agent", label: "E2e Agent", description: "The e2e seeded agent." };
/**
 * A command's PANEL label is its identity and its COMPOSER label is its invocation: `commandUi`
 * overrides `formatItemName` with identity (a command's name is what the user has to type), while
 * the composer row prefixes the slash. Measured, not assumed — the first run of this spec looked
 * for `/e2ecmd` in the panel and found nothing.
 */
const COMMAND = {
  name: "e2ecmd",
  panelLabel: "e2ecmd",
  menuLabel: "/e2ecmd",
  description: "The e2e seeded command.",
};
/** Written mid-run, to move the fingerprint and to prove the resync sees a disk change. */
const SECOND_SKILL = { name: "e2e-skill-two", label: "E2e Skill Two" };
/** S53 (V2-54): written mid-run for the CROSS-TAB case — tab A brings it in, tab B must see it. */
const THIRD_SKILL = { name: "e2e-skill-three", label: "E2e Skill Three" };

/** The footer buttons — `aria-label` is the panel label (`SidebarChrome.tsx`). */
const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const AGENTS_LABEL = /^(Менеджер Агентов|Agent manager)$/;
const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
/** `labels.refreshAria` on the wrapped `ItemsPanel`'s header toggle, one per manager. */
const SKILLS_REFRESH = /^(Обновить навыки|Refresh skills)$/;
const AGENTS_REFRESH = /^(Обновить агенты|Refresh agents)$/;
const COMMANDS_REFRESH = /^(Обновить команды|Refresh commands)$/;

/** The baseline captures are 1280×800 (`WORKFLOW/logs/baseline/views/index.json`). */
const BASELINE_VIEWPORT = { width: 1280, height: 800 } as const;

const write = (file: string, text: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text, "utf8");
};

const skillsRoot = (): string => NodePath.join(state().cliConfigDir, "skills");

const seedSkill = (name: string, description: string): void => {
  write(
    NodePath.join(skillsRoot(), name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`,
  );
};

const seedCliTree = (): void => {
  seedSkill(SKILL.name, SKILL.description);
  write(
    NodePath.join(state().cliConfigDir, "agents", `${AGENT.name}.md`),
    `---\nname: ${AGENT.name}\ndescription: ${AGENT.description}\n---\n\nYou are ${AGENT.name}.\n`,
  );
  write(
    NodePath.join(state().cliConfigDir, "commands", `${COMMAND.name}.toml`),
    `description = "${COMMAND.description}"\nprompt = "Do the e2e thing."\n`,
  );
};

const removeCliTree = (): void => {
  for (const dir of ["skills", "agents", "commands"]) {
    NodeFS.rmSync(NodePath.join(state().cliConfigDir, dir), { recursive: true, force: true });
  }
};

/**
 * How many distinct fake-CLI PROCESSES have ever run.
 *
 * A respawn is a new CLI process, and every line the fake ACP writes carries its own `pid=`
 * (`fake-acp-server.ts`), so a spawn is a pid that was not in the log before. This is the fact A25b
 * proved from the server's respawn log, taken one step closer to the CLI: the provider really was
 * restarted, not just decided about.
 *
 * MEASURED, NOT ASSUMED: the first version of this helper counted `session/new` lines, and the
 * uninstall case failed against it — after a server restart the adapter asks the new process to
 * RESUME the previous session id (`requestedResumeSessionId` in the app log), so a perfectly real
 * spawn logs no `session/new` at all. The pid is the honest signal for "a process was replaced".
 */
const acpProcessCount = (): number => {
  const file = NodePath.join(PLUGINS_ARTIFACTS_DIR, "fake-acp.log");
  if (!NodeFS.existsSync(file)) return 0;
  const pids = NodeFS.readFileSync(file, "utf8").match(/\bpid=(\d+)/g) ?? [];
  return new Set(pids).size;
};

/** How many times the gate has logged a catalog-driven respawn, across every boot of this run. */
const respawnLineCount = (): number =>
  (serverLogText().match(/catalog change → provider session respawn/g) ?? []).length;

/** Every app-boot log this run has written — the respawn gate's debug line lives in one of them. */
const serverLogText = (): string =>
  NodeFS.readdirSync(PLUGINS_ARTIFACTS_DIR)
    .filter((name) => name.startsWith("app-boot") && name.endsWith(".log"))
    .map((name) => NodeFS.readFileSync(NodePath.join(PLUGINS_ARTIFACTS_DIR, name), "utf8"))
    .join("\n");

/**
 * The RAW composer text the app has persisted.
 *
 * A catalog token is rendered as a Lexical CHIP, so `innerText` answers the chip's LABEL and cannot
 * carry a byte proof. The app persists what the editor would SEND — `ruCode:composer-drafts:v1`
 * (`composerDraftStore.ts`) — which is the source A24 read for its own insert-bytes evidence. Every
 * `ruCode:` key is scanned rather than that one, because whether the app lands the run on a
 * `/draft/<id>` or on a restored thread is its own thread-reuse policy and not this spec's business.
 */
const composerRawText = async (page: Page): Promise<string> =>
  await page.evaluate(() => {
    const parts: Array<string> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null || !key.startsWith("ruCode:")) continue;
      parts.push(window.localStorage.getItem(key) ?? "");
    }
    return parts.join("\n");
  });

/**
 * Wait until the app's environment connection is up, then leave the screen as it was.
 *
 * A turn sent while the connection is still coming up is queued, and after the server restart this
 * spec performs that took longer than the poll below allowed on the first run. The demo plugin's
 * status line renders `ctx.connection`, which is the exact fact a spawn needs, so the suite's own
 * helper is the cheapest honest predicate.
 */
const waitForConnection = async (page: Page): Promise<void> => {
  await openDemoPanel(page);
  await closeDemoPanel(page);
};

/**
 * Dismiss whatever toasts are parked over the right-hand slot.
 *
 * The app's toast portal renders OVER a plugin panel (a product finding the suite already documents
 * in `fixtures.ts` `clickPanelControl`), and this run always carries one: the harness seeds the
 * `demo-broken` fixture, whose «Плагин «Demo (broken)» не загрузился» card sits exactly where the
 * first catalog row is. Clearing it is only so the EVIDENCE shows the panel rather than the toast —
 * every assertion here reads the DOM, not the picture.
 */
const dismissToasts = async (page: Page): Promise<void> => {
  const closers = page.locator('[data-slot="toast-close"]');
  for (let guard = 0; guard < 6; guard += 1) {
    const count = await closers.count();
    if (count === 0) return;
    await closers
      .first()
      .dispatchEvent("click")
      .catch(() => undefined);
    await page.waitForTimeout(300);
  }
};

/**
 * V2-27: skills and agents are TABS of the thread's right panel now; commands is still the global
 * slot. The footer entry opens either one, so opening is unchanged — CLOSING is not, and that is
 * what this pair of helpers carries.
 */
const TAB_MOUNTED = new Set([String(SKILLS_LABEL), String(AGENTS_LABEL)]);

/** Open one catalog panel by its footer icon and wait for the wrapped panel's tabs. */
const openCatalogPanel = async (page: Page, label: RegExp): Promise<void> => {
  const button = page.getByRole("button", { name: label }).first();
  await expect(button, "the plugin's footer entry is on the rail").toBeVisible({ timeout: 30_000 });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await button.dispatchEvent("click");
  // The wrapped `ItemsPanel`'s own three tabs — the chrome the baseline captures show.
  await expect(page.getByRole("tab", { name: /^(Каталог|Catalog)$/ }).first()).toBeVisible({
    timeout: 30_000,
  });
};

/**
 * Press the open panel's REFRESH.
 *
 * The background resync fires once per page load (`ready ∧ (no baseline ∨ project-set changed)`),
 * so a file written while the page is already open is picked up by the panel's own Refresh — the
 * accepted trade the app made too: no FS watcher anywhere in the four wrapped packages.
 */
const refreshCatalogPanel = async (page: Page, refreshLabel: RegExp): Promise<void> => {
  const control = page.getByLabel(refreshLabel).first();
  await expect(control, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
  await control.dispatchEvent("click");
};

const closeCatalogPanel = async (page: Page, label: RegExp): Promise<void> => {
  if (TAB_MOUNTED.has(String(label))) {
    // V2-27: a tab is closed by its own ✕ (`RightPanelTabs.tsx`: `aria-label="Close <title>"`).
    // The footer entry FOCUSES a tab that is already open — it is not a toggle — so clicking it
    // again here would leave the panel on screen and the wait below would time out.
    const source = label.source.replace(/^\^\(|\)\$$/g, "");
    await page
      .locator("[data-right-panel-tab-list]")
      .getByRole("button", { name: new RegExp(`^Close (${source})$`) })
      .first()
      .dispatchEvent("click");
  } else {
    const button = page.getByRole("button", { name: label }).first();
    await button.dispatchEvent("click");
  }
  await expect(page.getByRole("tab", { name: /^(Каталог|Catalog)$/ })).toHaveCount(0, {
    timeout: 20_000,
  });
};

/**
 * Send a turn and wait for the app to accept it.
 *
 * The composer is a contenteditable whose first keystrokes can race the editor's mount, so Enter is
 * retried until the text has left the box — `tests-core/fixtures.ts` `sendPrompt`, verbatim in
 * intent.
 */
const sendPrompt = async (page: Page, text: string): Promise<void> => {
  const input = composer(page);
  await focusComposer(page);
  await page.keyboard.type(text, { delay: 10 });
  await expect(input).toContainText(text.slice(-12), { timeout: 20_000 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press("Enter");
    const emptied = await input
      .textContent()
      .then((value) => !(value ?? "").includes(text.slice(-12)))
      .catch(() => false);
    if (emptied) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`composer never emptied after sending: ${text}`);
};

test.describe("plugins — the catalogs plugin", () => {
  test.beforeAll(() => {
    seedCliTree();
  });

  test.afterAll(() => {
    removeCliTree();
  });

  test("three footer entries, three panels, and the seeded item in each", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(BASELINE_VIEWPORT);
    await openChat(page);

    const manifests = await fetchManifests();
    const row = manifests.find((entry) => entry.id === CATALOGS_ID);
    expect(row, "the catalogs plugin is in manifests.json").toBeDefined();
    expect(row).toMatchObject({ id: CATALOGS_ID, state: "loaded", hasWeb: true, hasServer: true });

    for (const label of [SKILLS_LABEL, AGENTS_LABEL, COMMANDS_LABEL]) {
      expect(
        await page.getByRole("button", { name: label }).count(),
        `exactly one footer entry for ${String(label)}`,
      ).toBe(1);
    }
    await dismissToasts(page);

    const panels: Record<string, string> = {};
    for (const [name, label, refreshLabel, itemLabel] of [
      ["panel-skills", SKILLS_LABEL, SKILLS_REFRESH, SKILL.label],
      ["panel-agents", AGENTS_LABEL, AGENTS_REFRESH, AGENT.label],
      ["panel-commands", COMMANDS_LABEL, COMMANDS_REFRESH, COMMAND.panelLabel],
    ] as const) {
      await openCatalogPanel(page, label);
      // The tree was seeded in `beforeAll`, i.e. AFTER this server process had already reconciled
      // its (empty) roots for an earlier spec — and since V2-41 a reconcile of a root set it has
      // already walked is answered from the store. The Refresh is what re-reads the disk, and it is
      // the same gesture a user makes after editing `~/.qwen` by hand.
      await refreshCatalogPanel(page, refreshLabel);
      // THE ATOM PROOF: the row can only be here if the wrapped UI read the PLUGIN's registry —
      // the resync and the Refresh are its only writers, and they write into that one registry.
      await expect
        .poll(() => page.getByText(itemLabel, { exact: false }).count(), {
          timeout: 60_000,
          intervals: [1_000],
          message: `the ${name} panel lists the seeded item`,
        })
        .toBeGreaterThan(0);
      panels[name] = await page.evaluate(() => document.body.innerText);
      await dismissToasts(page);
      await saveEvidenceScreenshot(page, name);
      await closeCatalogPanel(page, label);
    }

    saveEvidenceJson("catalogs-panels", {
      spec: "catalogs.e2e.test.ts",
      manifest: row,
      seeded: { skill: SKILL, agent: AGENT, command: COMMAND },
      panels,
    });
  });

  // S5, step 2. The ui-kit's `VscodeEntryIcon` used to inline 328 kB of icon lookup tables into
  // every bundle that touched the kit's barrel — 301 kB of this plugin's 507 kB web entry, paid on
  // first paint by every user for a view most never open. It loads them with a dynamic `import()`
  // now, which means TWO claims only a browser can settle: the plugin folder's lazy chunk is
  // actually reachable over the host's `/plugins/<id>/web/…` route (it serves whatever is in
  // `web/`, and the chunk is content-hashed, unlike `index.mjs`), and the icon still paints.
  test("the icon tables are a lazy chunk the host serves, fetched when a file list opens", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(BASELINE_VIEWPORT);

    const chunkResponses: Array<{ readonly url: string; readonly status: number }> = [];
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/plugins/catalogs/web/vscode-icons-")) {
        chunkResponses.push({ url, status: response.status() });
      }
    });
    // vscode-icons' SVGs come from jsdelivr, which this harness cannot reach. Answer them locally
    // so the `<img>` stays mounted instead of falling back to the neutral glyph on a network error:
    // the claim under test is OUR chunk and OUR resolver, not a CDN's uptime.
    await page.route("https://cdn.jsdelivr.net/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#888"/></svg>',
      }),
    );

    await openChat(page);
    await dismissToasts(page);
    await openCatalogPanel(page, SKILLS_LABEL);

    const item = page.getByRole("button", { name: new RegExp(SKILL.label) }).first();
    await expect(item, "the seeded skill's row").toBeVisible({ timeout: 60_000 });

    // NOT YET: the panel list draws lucide glyphs only, so nothing has paid for the tables.
    expect(chunkResponses, "no icon chunk is fetched to render the item LIST").toEqual([]);

    const clicked = await item
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) await item.dispatchEvent("click");

    const icon = page.locator('img[src*="vscode-icons"]').first();
    await expect(icon, "the file row's vscode icon").toBeVisible({ timeout: 60_000 });
    const iconSrc = (await icon.getAttribute("src")) ?? "";
    // `SKILL.md` resolves through the language table, not a bare extension match — i.e. BOTH
    // lazily-loaded tables were parsed, not just the manifest.
    expect(iconSrc).toContain("file_type_markdown");

    await expect
      .poll(
        () =>
          chunkResponses
            .filter((entry) => entry.url.includes("vscode-icons-manifest-"))
            .map((entry) => entry.status),
        { timeout: 30_000, intervals: [500], message: "the host served the manifest chunk" },
      )
      .toEqual([200]);
    expect(
      chunkResponses.every((entry) => entry.status === 200),
      `every icon chunk answered 200: ${JSON.stringify(chunkResponses)}`,
    ).toBe(true);
    expect(
      chunkResponses.some((entry) => entry.url.includes("vscode-icons-language-associations-")),
      "the language-association table is its own chunk too",
    ).toBe(true);

    await saveEvidenceScreenshot(page, "catalogs-file-icons");
    saveEvidenceJson("catalogs-icon-chunks", {
      spec: "catalogs.e2e.test.ts",
      claim: "VscodeEntryIcon loads its lookup tables on demand from the plugin folder",
      chunks: chunkResponses,
      iconSrc,
    });
    await closeCatalogPanel(page, SKILLS_LABEL);
  });

  test("the $ # / menus list the seeded rows and paste the exact token plus ONE space", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(BASELINE_VIEWPORT);
    await openChat(page);
    // BEFORE the first trigger, never between one and its screenshot: a click anywhere blurs the
    // composer and closes the menu the capture is of.
    await dismissToasts(page);

    const menus: Record<string, string> = {};
    const inserted: Record<string, string> = {};

    for (const [name, trigger, rowLabel, token] of [
      ["composer-dollar", "$", SKILL.label, `skill:⟦${SKILL.name}⟧ `],
      ["composer-hash", "#", AGENT.label, `agent:⟦${AGENT.name}⟧ `],
      ["composer-slash", "/", COMMAND.menuLabel, `/${COMMAND.name} `],
    ] as const) {
      await clearComposer(page);
      await typeTrigger(page, trigger);
      const row = commandMenu(page).getByText(rowLabel, { exact: false }).first();
      await expect(row, `the ${trigger} menu lists the seeded row`).toBeVisible({
        timeout: 30_000,
      });
      menus[name] = await commandMenuText(page);
      await saveEvidenceScreenshot(page, name);

      await row.click();
      // The bytes: the draft store keeps what the editor would SEND, chips resolved to tokens.
      await expect
        .poll(() => composerRawText(page), {
          timeout: 30_000,
          intervals: [500],
          message: `the ${trigger} row pastes its token`,
        })
        .toContain(token.trimEnd());
      const draft = await composerRawText(page);
      inserted[name] = draft;
      // ONE 0x20 after the token, never two — `insert` is verbatim in v2, so the space is the
      // plugin's and the host adds nothing.
      expect(draft, `${trigger}: exactly one trailing space`).toContain(token);
      expect(draft, `${trigger}: never a double space`).not.toContain(`${token} `);
      await clearComposer(page);
    }

    // The `#` menu also carries qwen's two built-in subagents, in their own section — the strings
    // `WORKFLOW/logs/baseline/views/composer-hash.txt` shows.
    await typeTrigger(page, "#");
    const hashMenu = await commandMenuText(page);
    expect(hashMenu, "the built-in subagents follow the catalog agents").toMatch(
      /General Purpose|Explore/,
    );
    menus["composer-hash-builtins"] = hashMenu;
    await clearComposer(page);

    saveEvidenceJson("catalogs-composer", { spec: "catalogs.e2e.test.ts", menus, inserted });
  });

  test("a file written on disk arrives with the panel's Refresh, and a page load never walks", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(BASELINE_VIEWPORT);

    // Written AFTER the app booted and after the previous cases loaded their pages — behind the
    // app's back, which is the only way a catalog file can appear without the app knowing.
    seedSkill(SECOND_SKILL.name, "Written on disk mid-run.");

    await openChat(page);
    await dismissToasts(page);
    await openCatalogPanel(page, SKILLS_LABEL);
    // HALF ONE (V2-41): this page's own reconcile did NOT walk the disk. The root set is the one
    // the process already reconciled, so the answer came from the store and the new file is not in
    // it. Nothing can bring it in on its own — there is no watcher and no poll — so this is a
    // settled state, not a race.
    await expect
      .poll(() => page.getByText(SKILL.label, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the panel is showing the catalog the store holds",
      })
      .toBeGreaterThan(0);
    expect(
      await page.getByText(SECOND_SKILL.label, { exact: false }).count(),
      "a page load does not walk the disk, so the new file is not here yet (V2-41)",
    ).toBe(0);

    // HALF TWO: the Refresh always walks, and it is the gesture the user has for exactly this.
    await refreshCatalogPanel(page, SKILLS_REFRESH);
    await expect
      .poll(() => page.getByText(SECOND_SKILL.label, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the Refresh brought the new skill into the panel",
      })
      .toBeGreaterThan(0);
    const panelText = await page.evaluate(() => document.body.innerText);
    expect(panelText, "and the first skill is still there").toContain(SKILL.label);
    await dismissToasts(page);
    await saveEvidenceScreenshot(page, "catalogs-resync");
    await closeCatalogPanel(page, SKILLS_LABEL);

    saveEvidenceJson("catalogs-resync", { spec: "catalogs.e2e.test.ts", panelText });
  });

  // ru-code S53 (V2-54): the OWNER'S CASE, in a real browser — "a change made in tab A's catalog
  // panel must show in tab B without a reload" (`WORKFLOW/queue/notify-seam.md`).
  //
  // RED BEFORE: without a server→web seam, tab B holds the rows its own reconcile read at boot and
  // nothing moves them — there is no watcher, no poll, and `ctx.invalidate` is web-local, so the
  // only way B learns is a reload. The case waits 20 s for a change that arrives in under one.
  //
  // Why REFRESH is the mutation: it is the one gesture that always walks the disk (V2-41), so the
  // server really does change what it holds, and it goes through the same publishing handler table
  // every panel mutation does. An `add` through the panel UI would prove the same thing with three
  // more clicks and a form.
  test("a catalog change in ONE tab reaches another tab with no reload", async ({ page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    await dismissToasts(page);
    await openCatalogPanel(page, SKILLS_LABEL);

    // TAB B: a second page of the same app, on the same server, with the same panel open.
    const other = await page.context().newPage();
    try {
      await openChat(other);
      await dismissToasts(other);
      await openCatalogPanel(other, SKILLS_LABEL);
      await expect
        .poll(() => other.getByText(SKILL.label, { exact: false }).count(), {
          timeout: 60_000,
          intervals: [1_000],
          message: "tab B is showing the catalog as it stands",
        })
        .toBeGreaterThan(0);
      expect(
        await other.getByText(THIRD_SKILL.label, { exact: false }).count(),
        "the third skill does not exist yet, in either tab",
      ).toBe(0);

      // The change: a file appears on disk and TAB A walks it in with its own Refresh.
      seedSkill(THIRD_SKILL.name, "Written for the cross-tab case.");
      await refreshCatalogPanel(page, SKILLS_REFRESH);
      await expect
        .poll(() => page.getByText(THIRD_SKILL.label, { exact: false }).count(), {
          timeout: 60_000,
          intervals: [1_000],
          message: "tab A walked the disk and has the new skill",
        })
        .toBeGreaterThan(0);

      // TAB B, WITHOUT A RELOAD: the server published the skills' store, B holds the new value.
      await expect
        .poll(() => other.getByText(THIRD_SKILL.label, { exact: false }).count(), {
          timeout: 20_000,
          intervals: [500],
          message: "tab B holds the published store — no reload, no click, no poll",
        })
        .toBeGreaterThan(0);

      saveEvidenceJson("catalogs-cross-tab", {
        spec: "catalogs.e2e.test.ts",
        skill: THIRD_SKILL.name,
        tabB: await other.evaluate(() => document.body.innerText.slice(0, 2000)),
      });
      await closeCatalogPanel(other, SKILLS_LABEL);
    } finally {
      await other.close();
    }
    await dismissToasts(page);
    await closeCatalogPanel(page, SKILLS_LABEL);
  });

  test("a catalog change between two turns respawns the provider session", async ({ page }) => {
    test.setTimeout(240_000);
    await openChat(page);
    // The panel is what performs the first reconcile on this page and gives the fingerprint
    // something to hash; without it the first turn and the second would both see an empty store.
    await openCatalogPanel(page, SKILLS_LABEL);
    await expect
      .poll(() => page.getByText(SKILL.label, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the catalog is reconciled before the first turn",
      })
      .toBeGreaterThan(0);
    await closeCatalogPanel(page, SKILLS_LABEL);

    await waitForConnection(page);
    const processesAtStart = acpProcessCount();
    const respawnsAtStart = respawnLineCount();
    await sendPrompt(page, "catalogs e2e first turn");
    await expect
      .poll(acpProcessCount, {
        timeout: 150_000,
        intervals: [1_000],
        message: "the first turn spawns a provider process",
      })
      .toBeGreaterThan(processesAtStart);
    const processesBefore = acpProcessCount();

    // The catalog change: a THIRD skill on disk, then the panel's own reconcile so the plugin's
    // durable store — what `session.fingerprint` hashes — really moves.
    seedSkill("e2e-skill-three", "Written between two turns.");
    await openCatalogPanel(page, SKILLS_LABEL);
    await refreshCatalogPanel(page, SKILLS_REFRESH);
    await expect
      .poll(() => page.getByText("E2e Skill Three", { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the new skill is in the catalog before the second turn",
      })
      .toBeGreaterThan(0);
    await closeCatalogPanel(page, SKILLS_LABEL);

    await sendPrompt(page, "catalogs e2e second turn");
    await expect
      .poll(acpProcessCount, {
        timeout: 120_000,
        intervals: [1_000],
        message: "the catalog change forced a NEW provider process",
      })
      .toBeGreaterThan(processesBefore);

    const log = serverLogText();
    expect(respawnLineCount(), "the gate logged a catalog-driven respawn").toBeGreaterThan(
      respawnsAtStart,
    );
    expect(log, "and it names this plugin's hook as the changed source").toContain(
      "plugin:catalogs",
    );

    saveEvidenceJson("catalogs-respawn", {
      spec: "catalogs.e2e.test.ts",
      processesBefore,
      processesAfter: acpProcessCount(),
      respawnsAtStart,
      respawnsAfter: respawnLineCount(),
      respawnLines: log
        .split("\n")
        .filter((line) => line.includes("ru-code-respawn"))
        .slice(-6),
    });
  });

  test("uninstalling the folder leaves no entries, no rows and no respawn", async ({ page }) => {
    test.setTimeout(300_000);

    const running = state();
    await stopPluginsApp(running);
    removePluginFolder(running.pluginsDir, CATALOGS_ID);
    await restartPluginsApp(running);

    const manifests = await fetchManifests();
    expect(
      manifests.map((entry) => entry.id),
      "the deleted plugin is no longer in manifests.json",
    ).not.toContain(CATALOGS_ID);
    expect(await statusOf(`/plugins/${CATALOGS_ID}/web/index.mjs`), "its web entry 404s").toBe(404);

    await openChat(page);
    // More than the loader's whole per-plugin budget, so "registers nothing" is a measured fact.
    await page.waitForTimeout(3_000);
    await waitForConnection(page);

    for (const label of [SKILLS_LABEL, AGENTS_LABEL, COMMANDS_LABEL]) {
      expect(
        await page.getByRole("button", { name: label }).count(),
        `no footer entry for ${String(label)}`,
      ).toBe(0);
    }

    // Typed WITHOUT `typeTrigger`: a menu that never opens is the PASS here, not something to wait
    // 20 s for three times over.
    const menus: Record<string, string> = {};
    for (const [key, trigger] of [
      ["skill", "$e2e"],
      ["agent", "#e2e"],
      ["command", "/e2ecmd"],
    ] as const) {
      await focusComposer(page);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(trigger, { delay: 30 });
      await page.waitForTimeout(1_500);
      menus[key] = await commandMenuText(page);
      expect(menus[key], `the ${key} menu lists nothing from the catalogs plugin`).not.toMatch(
        /E2e Skill|E2e Agent|\/e2ecmd/,
      );
    }
    await clearComposer(page);
    await saveEvidenceScreenshot(page, "catalogs-uninstalled");

    // …and a catalog change no longer respawns anything: the aggregate has no hook to ask.
    const respawnsBefore = respawnLineCount();
    const processesBefore = acpProcessCount();
    await sendPrompt(page, "after uninstall first turn");
    await expect
      .poll(acpProcessCount, {
        timeout: 150_000,
        intervals: [1_000],
        message: "the first turn after the restart spawns a provider process",
      })
      .toBeGreaterThan(processesBefore);
    const processesAfterFirst = acpProcessCount();
    seedSkill("e2e-skill-four", "Written with the plugin uninstalled.");
    await sendPrompt(page, "after uninstall second turn");
    // Long enough that a respawn would have happened: the respawn case above needed far less.
    await page.waitForTimeout(20_000);
    expect(
      acpProcessCount(),
      "with no plugin there is no fingerprint, so the SAME provider process serves both turns",
    ).toBe(processesAfterFirst);
    expect(respawnLineCount(), "and the gate logs no catalog-driven respawn").toBe(respawnsBefore);

    saveEvidenceJson("catalogs-uninstall", {
      spec: "catalogs.e2e.test.ts",
      manifestsAfter: manifests.map((entry) => entry.id),
      webEntryStatus: await statusOf(`/plugins/${CATALOGS_ID}/web/index.mjs`),
      menus,
      processesBefore,
      processesAfterFirst,
      processesAfterSecond: acpProcessCount(),
      respawnsBefore,
      respawnsAfter: respawnLineCount(),
    });

    // ── put it back, so the rest of the suite runs against the app it expects ──────────────────
    const stopped = state();
    await stopPluginsApp(stopped);
    installPluginFolder(stopped.pluginsDir, CATALOGS_ID, CATALOGS_DIST);
    await restartPluginsApp(stopped);
    expect(
      (await fetchManifests()).map((entry) => entry.id),
      "the plugin is reinstalled for the specs that follow",
    ).toContain(CATALOGS_ID);
  });
});
