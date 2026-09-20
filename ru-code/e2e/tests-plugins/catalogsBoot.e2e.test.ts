// ru-code S38 — WHAT A BOOT COSTS, per plugin, in frames and in disk walks.
//
// Rule 36: "Boot and open paths get FRAME-COUNT and BYTE-COUNT assertions." Before this file the
// plugins suite had exactly one such assertion and it covered one plugin (`analyticsColdOpen`,
// S37 §1.8); the S37 analyst could therefore say nothing about catalogs or demo (§c, "agreement on
// analytics, silence on catalogs and demo"), and the two duplicate-fetch defects it found by
// reading the code (§b: a restored TAB fetches the snapshot the background prime already fetched;
// an EMPTY catalog is re-fetched on every composer recompute) had no spec anywhere.
//
// TWO SCENARIOS, the two the owner actually runs:
//
//  (i)  COLD — a never-used base dir, 0 projects, a plugin PAGE opened first. Nothing is on disk,
//       so every catalog answers `[]`, and this is the FLOOR: per kind one `rescan` (the background
//       reconcile) and one `snapshot` (the composer prime), demo's one `notes.list`, analytics'
//       `getSnapshot` + `refresh`. Nothing else may appear — and nothing may repeat.
//
//  (ii) WARM + F5 — the suite's shared app with a project, a thread open and the Skills TAB
//       restored (a tab is persisted per thread, `tabSurfaces.tsx`), the catalogs seeded on disk.
//       This is where the growth was: the restored tab's own snapshot, and one
//       `context.build` from the DEMO plugin for every catalogs invalidation, because the host's
//       seam version was a cross-plugin SUM (V2-40).
//
// AND WHAT F5 COSTS THE DISK (V2-41). A rescan that walks writes `meta.json` for every reconciled
// item (`qwen-cli-catalog-core/src/server/engine.ts:155-162` → `CatalogStore.putMetaStored`), so a
// walk is VISIBLE on the filesystem and a store-served answer is not. That is the observable this
// spec uses, because the engine's own `[ru-code-catalog] rescan complete` line is NOT observable:
// it is `Effect.logDebug` inside the plugin bundle's own `ManagedRuntime`, whose default logger
// filters below Info, and no such line appears in any harness log (proven in `WORKFLOW/logs/S38/`).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  startColdPluginsApp,
  stopPluginsApp,
  type PluginsHarnessState,
} from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import { expect, openChat, state, test, type Page } from "./fixtures.ts";
import {
  PLUGIN_WIRE_INIT,
  frameCounts,
  frames,
  pluginWire,
  type PluginWire,
} from "./pluginWire.ts";

const ANALYTICS_LABEL = /^(Аналитика|Analytics)$/;
const APP_SHELL_LABEL = /Добавить проект|Add project/;
const ANALYTICS_PAGE = '[data-testid="analytics-page"]';
const SKILLS_LABEL = /^(Менеджер Навыков|Skill manager)$/;
const SKILLS_REFRESH = /^(Обновить навыки|Refresh skills)$/;
const CATALOG_TAB = /^(Каталог|Catalog)$/;

/** This spec's own items, so it never depends on what another spec left on disk. */
const SKILL = { name: "s38-boot-skill", label: "S38 Boot Skill" };
const AGENT = { name: "s38-boot-agent" };
const COMMAND = { name: "s38bootcmd" };

const write = (file: string, text: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text, "utf8");
};

const seedCliTree = (cliConfigDir: string): void => {
  write(
    NodePath.join(cliConfigDir, "skills", SKILL.name, "SKILL.md"),
    `---\nname: ${SKILL.name}\ndescription: The S38 boot skill.\n---\n\n# ${SKILL.name}\n`,
  );
  write(
    NodePath.join(cliConfigDir, "agents", `${AGENT.name}.md`),
    `---\nname: ${AGENT.name}\ndescription: The S38 boot agent.\n---\n\nYou are ${AGENT.name}.\n`,
  );
  write(
    NodePath.join(cliConfigDir, "commands", `${COMMAND.name}.toml`),
    `description = "The S38 boot command."\nprompt = "Do the S38 thing."\n`,
  );
};

const removeCliTree = (cliConfigDir: string): void => {
  for (const dir of ["skills", "agents", "commands"]) {
    NodeFS.rmSync(NodePath.join(cliConfigDir, dir), { recursive: true, force: true });
  }
};

/**
 * Every `meta.json` mtime in the three catalog stores — the DISK-WALK observable.
 *
 * A rescan that reaches the engine rewrites one per reconciled item, whether or not anything
 * changed (engine.ts:155-162). So this list moving means "the disk was walked", and this list
 * standing still means "the answer came from the store".
 */
const metaStamps = (baseDir: string): Record<string, number> => {
  const stamps: Record<string, number> = {};
  for (const kind of ["skill", "agent", "command"]) {
    const root = NodePath.join(baseDir, "userdata", "plugins", "catalogs", `${kind}-catalog`);
    if (!NodeFS.existsSync(root)) continue;
    for (const id of NodeFS.readdirSync(root)) {
      const meta = NodePath.join(root, id, "meta.json");
      if (!NodeFS.existsSync(meta)) continue;
      stamps[`${kind}/${id}`] = NodeFS.statSync(meta).mtimeMs;
    }
  }
  return stamps;
};

const changedStamps = (
  before: Record<string, number>,
  after: Record<string, number>,
): ReadonlyArray<string> =>
  Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]);

/**
 * Wait until the wire goes quiet: no new `plugin.invoke` frame for two consecutive polls.
 *
 * A frame count is only a fact once the page has settled, and "settled" cannot be a fixed sleep —
 * the reconcile answer can land seconds after boot on a real corpus. This waits for the EVENT that
 * ends the boot (the last frame), which is the same rule the engine itself lives by (rule 38).
 */
const settle = async (page: Page, quietPolls = 4): Promise<PluginWire> => {
  let last = -1;
  let quiet = 0;
  let wire = await pluginWire(page);
  for (let tick = 0; tick < 120; tick += 1) {
    wire = await pluginWire(page);
    // A run that has seen NO frame at all has not settled, it has not started — a recorder that
    // records nothing must show up as a timeout here, never as a passing zero.
    if (wire.requests.length > 0 && wire.requests.length === last) {
      quiet += 1;
      if (quiet >= quietPolls) return wire;
    } else {
      quiet = 0;
      last = wire.requests.length;
    }
    await page.waitForTimeout(500);
  }
  return wire;
};

/**
 * Open the Skills panel and press its Refresh — the only thing that WALKS the disk (V2-41).
 *
 * The CLI tree is seeded in `beforeAll`, i.e. after this server process has already reconciled its
 * roots for an earlier spec, and a reconcile of a root set it has already walked is answered from
 * the store. So bringing a hand-written file in is the user's own gesture, and it is also what
 * makes the catalog WARM for the reload this file measures.
 */
const warmTheCatalog = async (page: Page): Promise<void> => {
  const skills = page.getByRole("button", { name: SKILLS_LABEL }).first();
  await expect(skills, "the catalogs plugin's footer entry").toBeVisible({ timeout: 60_000 });
  await skills.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
    timeout: 30_000,
  });
  const refresh = page.getByLabel(SKILLS_REFRESH).first();
  await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
  await refresh.dispatchEvent("click");
  await expect
    .poll(() => page.getByText(SKILL.label, { exact: false }).count(), {
      timeout: 90_000,
      intervals: [1_000],
      message: "the Refresh walked the disk and the seeded skill is in the panel",
    })
    .toBeGreaterThan(0);
};

const report = (wire: PluginWire): string =>
  `frames=${JSON.stringify(frameCounts(wire))} raw=${JSON.stringify(
    wire.requests.map((request) => `${request.pluginId}.${request.method}`),
  )}`;

// ── (i) COLD: a fresh install, 0 projects, the analytics page opened first ─────────────────────

test.describe("plugins — the boot's own cost, cold", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let cold: PluginsHarnessState | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    cold = await startColdPluginsApp({ logName: "app-cold-s38-boot.log" });
  });

  test.afterAll(async () => {
    if (cold === null) return;
    await stopPluginsApp(cold);
    if (NodePath.basename(cold.tmpRoot).startsWith("ru-code-e2e-plugins-cold-")) {
      NodeFS.rmSync(cold.tmpRoot, { recursive: true, force: true });
    }
    cold = null;
  });

  test("a cold boot costs each plugin exactly its floor, and nothing repeats", async ({ page }) => {
    test.setTimeout(300_000);
    const app = cold;
    expect(app, "the cold app booted").not.toBeNull();
    if (app === null) return;

    await page.addInitScript(PLUGIN_WIRE_INIT);
    await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: APP_SHELL_LABEL }).first(),
      "the fresh browser reaches the authenticated app shell (0 projects)",
    ).toBeVisible({ timeout: 60_000 });

    // The owner's own first move: straight to a plugin PAGE.
    const analytics = page.getByRole("button", { name: ANALYTICS_LABEL }).first();
    await expect(analytics, "the analytics plugin contributed its nav entry").toBeVisible({
      timeout: 60_000,
    });
    await analytics.dispatchEvent("click");
    await expect(page.locator(ANALYTICS_PAGE)).toBeVisible({ timeout: 30_000 });

    const wire = await settle(page);
    const counts = frameCounts(wire);
    saveEvidenceJson("38-boot-cold", {
      spec: "catalogsBoot.e2e.test.ts",
      scenario: "cold base dir · 0 projects · the analytics page opened first",
      counts,
      requests: wire.requests,
    });

    // CATALOGS — the floor the S37 analyst derived (§c): one reconcile and one prime per kind.
    for (const kind of ["skill", "agent", "command"]) {
      expect(
        frames(wire, "catalogs", `${kind}.rescan`),
        `one ${kind}.rescan — ${report(wire)}`,
      ).toBe(1);
      expect(
        frames(wire, "catalogs", `${kind}.snapshot`),
        `one ${kind}.snapshot — ${report(wire)}`,
      ).toBe(1);
    }
    // DEMO — its background's one `notes.list`. No thread, so no "/" runner and no `context.build`.
    expect(frames(wire, "demo", "notes.list"), `one demo notes.list — ${report(wire)}`).toBe(1);
    expect(
      frames(wire, "demo", "context.build"),
      `no demo context.build with no thread open — ${report(wire)}`,
    ).toBe(0);
    // ANALYTICS — the page reads the cache once and scans once (S37 §1.8, same floor).
    expect(
      frames(wire, "analytics", "analytics.getSnapshot"),
      `one analytics.getSnapshot — ${report(wire)}`,
    ).toBe(1);
    expect(
      frames(wire, "analytics", "analytics.refresh"),
      `one analytics.refresh — ${report(wire)}`,
    ).toBe(1);
    // …and NOTHING else reached the wire from a plugin.
    expect(Object.keys(counts).toSorted(), `exactly the floor set — ${report(wire)}`).toEqual(
      [
        "analytics analytics.getSnapshot",
        "analytics analytics.refresh",
        "catalogs agent.rescan",
        "catalogs agent.snapshot",
        "catalogs command.rescan",
        "catalogs command.snapshot",
        "catalogs skill.rescan",
        "catalogs skill.snapshot",
        "demo notes.list",
      ].toSorted(),
    );
  });
});

// ── (ii) WARM + F5: one project, a thread, the Skills tab restored ─────────────────────────────

test.describe("plugins — what a reload costs, warm", () => {
  test.beforeAll(() => {
    seedCliTree(state().cliConfigDir);
  });

  test.afterAll(() => {
    removeCliTree(state().cliConfigDir);
  });

  test("F5 with a restored tab: one reconcile and one prime per kind, ZERO disk walks", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const app = state();

    // ── warm the app up: a thread, and the Skills tab open so the reload restores it ──────────
    await page.addInitScript(PLUGIN_WIRE_INIT);
    await openChat(page);
    await warmTheCatalog(page);
    await settle(page);

    // ── THE RELOAD. The recorder re-arms on navigation, so what follows is the reload's own cost.
    const stampsBefore = metaStamps(app.baseDir);
    expect(
      Object.keys(stampsBefore).length,
      "the three catalog stores hold items, so a walk would be visible",
    ).toBeGreaterThan(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => page.getByText(SKILL.label, { exact: false }).count(), {
        timeout: 90_000,
        intervals: [1_000],
        message: "the restored tab paints the catalog again",
      })
      .toBeGreaterThan(0);
    const wire = await settle(page);
    const counts = frameCounts(wire);
    const stampsAfter = metaStamps(app.baseDir);
    const walked = changedStamps(stampsBefore, stampsAfter);

    saveEvidenceJson("38-boot-warm-reload", {
      spec: "catalogsBoot.e2e.test.ts",
      scenario: "warm base dir · one project · thread open · Skills tab restored · F5",
      counts,
      requests: wire.requests,
      metaWritesOnReload: walked,
    });

    // 1. FRAME COUNT — the same floor as the cold boot, with a tab and a thread on screen. The
    //    restored tab costs NOTHING: the background prime already filled the atom and marked the
    //    catalog loaded, so `useItemCatalog` paints from the cache (V2-41 / S37-analyst §b B-1).
    for (const kind of ["skill", "agent", "command"]) {
      expect(
        frames(wire, "catalogs", `${kind}.rescan`),
        `one ${kind}.rescan on a reload — ${report(wire)}`,
      ).toBe(1);
      expect(
        frames(wire, "catalogs", `${kind}.snapshot`),
        `one ${kind}.snapshot on a reload, tab or no tab — ${report(wire)}`,
      ).toBe(1);
    }
    // 2. The DEMO plugin is asked for its `/` row ONCE — at the ChatView mount. Every catalogs
    //    invalidation used to re-ask it too, because the host's seam version was a cross-plugin
    //    SUM (V2-40); an unrelated plugin's data moving must not cost a wire frame.
    expect(
      frames(wire, "demo", "context.build"),
      `the demo's "/" row is built ONCE per reload — ${report(wire)}`,
    ).toBe(1);
    expect(frames(wire, "demo", "notes.list"), `one demo notes.list — ${report(wire)}`).toBe(1);

    // 3. ZERO DISK WALKS. The reload's three `rescan` calls were answered from the reconciled
    //    store: not one `meta.json` was rewritten (V2-41).
    expect(walked, `F5 walked the disk for: ${JSON.stringify(walked)}`).toEqual([]);
  });

  test("the panel's Refresh DOES walk the disk", async ({ page }) => {
    test.setTimeout(300_000);
    const app = state();

    await openChat(page);
    await warmTheCatalog(page);

    const before = metaStamps(app.baseDir);
    const refresh = page.getByLabel(SKILLS_REFRESH).first();
    await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
    await refresh.dispatchEvent("click");

    await expect
      .poll(() => changedStamps(before, metaStamps(app.baseDir)).length, {
        timeout: 60_000,
        intervals: [500],
        message: "the manual Refresh reached the disk (meta.json rewritten)",
      })
      .toBeGreaterThan(0);

    saveEvidenceJson("38-refresh-walks", {
      spec: "catalogsBoot.e2e.test.ts",
      claim: "force:true — the panel's Refresh always walks, whatever the reconciled flag says",
      rewritten: changedStamps(before, metaStamps(app.baseDir)),
    });
  });
});
