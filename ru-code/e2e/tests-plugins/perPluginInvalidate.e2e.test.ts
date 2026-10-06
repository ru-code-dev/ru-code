// ru-code S38 (V2-40) — ONE PLUGIN'S `invalidate` IS ONE PLUGIN'S RECOMPUTE.
//
// THE PROMISE. `ctx.invalidate(seam)` is documented as "the host recomputes that seam for YOUR
// plugin only" (`plugin-sdk/src/host/index.ts:156`).
//
// WHAT THE HOST DID INSTEAD. `invalidations.ts` kept a version per (plugin, seam) AND a cross-plugin
// SUM per seam, and the runners keyed on the SUM — so every plugin's seam was re-asked whenever ANY
// plugin invalidated. The S37 analyst traced the cost end to end (§d): the catalogs plugin's bridge
// fires `invalidate("composer")` after a resync, the "/" runner re-runs, `collectPluginComposerRows`
// calls EVERY plugin's `items`, and the demo plugin's "/" row is
// `insert: ${await ctx.invoke("context.build")}` — a wire frame for a plugin whose data did not
// move, once per unrelated invalidation. The S38 boot measurement counted TEN of them on a single
// reload (`WORKFLOW/logs/S38/1-e2e-boot-red.log`).
//
// THIS SPEC IS THE SHARP VERSION OF THAT. One catalogs invalidation, mid-session, with the page
// already settled — the user's own "I added a command, refresh" gesture, which is the only thing
// that moves at that point. Then:
//
//   · the DEMO plugin sends NOT ONE frame (its contribution did not change), and
//   · the CATALOGS rows DO update (the invalidation reached the plugin that made it).
//
// Both halves matter: a host that re-asks nobody would pass the first and fail the second.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import {
  clearComposer,
  closeDemoPanel,
  commandMenu,
  expect,
  openChat,
  openDemoPanel,
  state,
  test,
  typeTrigger,
  type Page,
} from "./fixtures.ts";
import {
  PLUGIN_WIRE_INIT,
  frameCounts,
  frames,
  pluginWire,
  type PluginWire,
} from "./pluginWire.ts";

/** Seeded BEFORE the page opens, so the boot reconcile brings it in. */
const FIRST = "s38inva";
/** Written with the page already live — the change the panel's Refresh brings in. */
const SECOND = "s38invb";

const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
const COMMANDS_REFRESH = /^(Обновить команды|Refresh commands)$/;
const CATALOG_TAB = /^(Каталог|Catalog)$/;

const commandFile = (name: string): string =>
  NodePath.join(state().cliConfigDir, "commands", `${name}.toml`);

const seedCommand = (name: string): void => {
  const file = commandFile(name);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    `description = "The S38 ${name} command."\nprompt = "Do the S38 thing."\n`,
    "utf8",
  );
};

/** Wait for the app's environment connection, off the demo plugin's own `ctx.connection` line. */
const waitForConnection = async (page: Page): Promise<void> => {
  await openDemoPanel(page);
  await closeDemoPanel(page);
};

const dismissToasts = async (page: Page): Promise<void> => {
  const closers = page.locator('[data-slot="toast-close"]');
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await closers.count()) === 0) return;
    await closers
      .first()
      .dispatchEvent("click")
      .catch(() => undefined);
    await page.waitForTimeout(300);
  }
};

/** No new `plugin.invoke` frame for four consecutive polls — the page has stopped talking. */
const settle = async (page: Page): Promise<PluginWire> => {
  let last = -1;
  let quiet = 0;
  let wire = await pluginWire(page);
  for (let tick = 0; tick < 120; tick += 1) {
    wire = await pluginWire(page);
    if (wire.requests.length > 0 && wire.requests.length === last) {
      quiet += 1;
      if (quiet >= 4) return wire;
    } else {
      quiet = 0;
      last = wire.requests.length;
    }
    await page.waitForTimeout(500);
  }
  return wire;
};

test.describe("plugins — a plugin's invalidate recomputes that plugin only (V2-40)", () => {
  test.beforeAll(() => {
    seedCommand(FIRST);
  });

  test.afterAll(() => {
    for (const name of [FIRST, SECOND]) NodeFS.rmSync(commandFile(name), { force: true });
  });

  test("a catalogs invalidate does not re-invoke the demo", async ({ page }) => {
    test.setTimeout(300_000);

    await page.addInitScript(PLUGIN_WIRE_INIT);
    await openChat(page);
    await waitForConnection(page);
    await dismissToasts(page);

    // The seeded command was written after this server process had already reconciled its roots,
    // and since V2-41 a reconcile of a root set it has walked is answered from the store — so the
    // panel's own Refresh is what brings a hand-written file in. It is also the gesture this spec
    // measures later, which makes the BEFORE and AFTER states identical but for one invalidation.
    const panelButton = page.getByRole("button", { name: COMMANDS_LABEL }).first();
    await expect(panelButton, "the plugin's footer entry is on the rail").toBeVisible({
      timeout: 30_000,
    });
    await panelButton.dispatchEvent("click");
    await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(COMMANDS_REFRESH).first().dispatchEvent("click");
    await expect
      .poll(() => page.getByText(FIRST, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the Refresh brought the seeded command into the panel",
      })
      .toBeGreaterThan(0);
    await panelButton.dispatchEvent("click");
    await expect(page.getByRole("tab", { name: CATALOG_TAB })).toHaveCount(0, { timeout: 20_000 });

    // The "/" runner must be LIVE before the measurement — that is the consumer the demo's row
    // hangs off (`ChatView.tsx` → `useQwenPluginCommandSlugs` → `useContributedComposerRows("/", "")`,
    // every contributed row — S111 #6).
    await clearComposer(page);
    await typeTrigger(page, "/");
    await expect(
      commandMenu(page).getByText(`/${FIRST}`, { exact: false }).first(),
      "the seeded command is in the `/` menu, so the catalogs rows are live",
    ).toBeVisible({ timeout: 60_000 });
    await clearComposer(page);

    const before = await settle(page);
    const demoBefore = frames(before, "demo", "context.build");
    expect(
      demoBefore,
      "the demo's `/` row was built at least once before the measurement",
    ).toBeGreaterThan(0);

    // ── THE ONE EVENT: a catalogs change, brought in by the panel's own Refresh ───────────────
    seedCommand(SECOND);
    await panelButton.dispatchEvent("click");
    await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
      timeout: 30_000,
    });
    const refresh = page.getByLabel(COMMANDS_REFRESH).first();
    await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
    await refresh.dispatchEvent("click");
    await expect
      .poll(() => page.getByText(SECOND, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the panel lists the new command after its own Refresh",
      })
      .toBeGreaterThan(0);
    await panelButton.dispatchEvent("click");
    await expect(page.getByRole("tab", { name: CATALOG_TAB })).toHaveCount(0, { timeout: 20_000 });
    await dismissToasts(page);

    const after = await settle(page);
    const demoAfter = frames(after, "demo", "context.build");

    // ── the second half: the invalidation DID reach catalogs ─────────────────────────────────
    await clearComposer(page);
    await typeTrigger(page, "/");
    await expect(
      commandMenu(page).getByText(`/${SECOND}`, { exact: false }).first(),
      "the catalogs rows updated — the invalidation was not simply swallowed",
    ).toBeVisible({ timeout: 60_000 });
    await clearComposer(page);

    saveEvidenceJson("38-per-plugin-invalidate", {
      spec: "perPluginInvalidate.e2e.test.ts",
      claim: "one plugin's ctx.invalidate recomputes that plugin's seam only (V2-40)",
      demoContextBuildBefore: demoBefore,
      demoContextBuildAfter: demoAfter,
      countsAfter: frameCounts(after),
    });

    expect(
      demoAfter,
      `the demo plugin sent no frame for a catalogs invalidation — ` +
        `before=${String(demoBefore)} after=${String(demoAfter)} ` +
        `counts=${JSON.stringify(frameCounts(after))}`,
    ).toBe(demoBefore);
  });
});
