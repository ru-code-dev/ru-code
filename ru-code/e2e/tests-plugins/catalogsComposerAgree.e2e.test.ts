// ru-code S38 — THE PANEL AND THE COMPOSER TELL THE USER THE SAME THING.
//
// The catalogs plugin has two consumers of ONE atom: the panel (the wrapped `ItemsPanel`, which
// renders `catalogDataAtom` through `useItemCatalogList`) and the composer seam
// (`catalogComposerItems`, which reads the same atom synchronously). The app's submit guard takes a
// third read of the same data (`useQwenPluginCommandSlugs`). Any change that makes one of them
// answer from a cache the others do not share is a user-visible lie: a command that is in the panel
// and refused at Enter, or offered in the menu and missing from the panel.
//
// S38 puts a cache in front of BOTH ends of that path — a per-plugin seam memo in the host (V2-40)
// and a reconciled-store gate in front of the engine's `rescan` (V2-41) — so this is the pin that
// says the caches did not change what the user is told.
//
// IT DRIVES THE PANEL'S OWN CREATE, not a file written behind the app's back: `add` →
// `rescanAndPrime` → `primeCatalog` is the mutation path the gate sits on, and
// `slashGuard.e2e.test.ts` already covers the disk-write + Refresh path. The item is then CONNECTED
// globally, because an item with no enabled binding is deliberately not offered in the composer
// (`qwen-cli-catalog-core/src/contracts/catalogPicker.ts:19-30` `selectEffectiveItems`).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PLUGINS_ARTIFACTS_DIR } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson } from "../harness/pluginsEvidence.ts";

import {
  clearComposer,
  closeDemoPanel,
  commandMenu,
  composer,
  expect,
  focusComposer,
  openChat,
  openDemoPanel,
  state,
  test,
  typeTrigger,
  type Page,
} from "./fixtures.ts";

/** Created THROUGH THE PANEL, never written to disk by this spec. */
const CREATED = "s38agree";

const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
const COMMANDS_REFRESH = /^(Обновить команды|Refresh commands)$/;
const CATALOG_TAB = /^(Каталог|Catalog)$/;
const GLOBAL_TAB = /^(Глобально)$/;
const CREATE_COMMAND = /^(Создать команду)$/;
/** The name field is reached by its PLACEHOLDER: `Field`/`FieldLabel` do not associate a label. */
const NAME_PLACEHOLDER = "git:fetch";
const SUBMIT = /^(Создать)$/;
const ADD_TO_SCOPE = /^(Добавить)$/;

/**
 * Take the command out of the durable store and off the CLI tree.
 *
 * The suite shares ONE app and ONE base dir, so a previous run of this file (or a run that failed
 * half way) would leave the row behind and `add` would answer "уже существует" — the spec would
 * then pass without ever exercising the create it exists for. The store is a plain directory of
 * `<uuid>/meta.json` (`CatalogStore.ts:3-5`) read per call, so removing a row while the server is
 * up is the same thing as the user deleting it.
 */
const forgetCommand = (): void => {
  const app = state();
  NodeFS.rmSync(NodePath.join(app.cliConfigDir, "commands", `${CREATED}.toml`), { force: true });
  const store = NodePath.join(app.baseDir, "userdata", "plugins", "catalogs", "command-catalog");
  if (!NodeFS.existsSync(store)) return;
  for (const id of NodeFS.readdirSync(store)) {
    const meta = NodePath.join(store, id, "meta.json");
    if (!NodeFS.existsSync(meta)) continue;
    const row = JSON.parse(NodeFS.readFileSync(meta, "utf8")) as { readonly name?: string };
    if (row.name === CREATED)
      NodeFS.rmSync(NodePath.join(store, id), { recursive: true, force: true });
  }
};

/** Every prompt the fake CLI has been handed, in order (`fake-acp-server.ts:323`). */
const promptsSeen = (): ReadonlyArray<string> => {
  const file = NodePath.join(PLUGINS_ARTIFACTS_DIR, "fake-acp.log");
  if (!NodeFS.existsSync(file)) return [];
  return [...NodeFS.readFileSync(file, "utf8").matchAll(/^.*? prompt text: (.*)$/gm)].map(
    (match) => match[1] ?? "",
  );
};

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

const openCommandsPanel = async (page: Page): Promise<void> => {
  const button = page.getByRole("button", { name: COMMANDS_LABEL }).first();
  await expect(button, "the plugin's footer entry is on the rail").toBeVisible({ timeout: 30_000 });
  await button.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: CATALOG_TAB }).first()).toBeVisible({
    timeout: 30_000,
  });
};

const closeCommandsPanel = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: COMMANDS_LABEL }).first().dispatchEvent("click");
  await expect(page.getByRole("tab", { name: CATALOG_TAB })).toHaveCount(0, { timeout: 20_000 });
};

/** Every name the «Глобально» tab lists, as the panel renders them. */
const globalTabNames = async (page: Page): Promise<ReadonlyArray<string>> => {
  await page.getByRole("tab", { name: GLOBAL_TAB }).first().dispatchEvent("click");
  await expect(page.getByRole("tab", { name: GLOBAL_TAB }).first()).toBeVisible({
    timeout: 20_000,
  });
  // The rows are the only `font-medium` names inside the tab's scroller; reading the panel's text
  // and matching this suite's own `s38`/`e2e` namespaces keeps it independent of the row markup.
  const text = await page.locator('[data-slot="dialog-panel"], body').first().innerText();
  return [...text.matchAll(/\b((?:s38|e2e)[a-z0-9-]*)\b/g)].map((match) => match[1] ?? "");
};

/** Every `/command` row the composer menu currently offers. */
const composerCommandNames = async (page: Page): Promise<ReadonlyArray<string>> => {
  await clearComposer(page);
  await typeTrigger(page, "/");
  await expect(commandMenu(page)).toBeVisible({ timeout: 30_000 });
  const text = await commandMenu(page).innerText();
  await clearComposer(page);
  return [...text.matchAll(/\/((?:s38|e2e)[a-z0-9-]*)/g)].map((match) => match[1] ?? "");
};

test.describe("plugins — the catalogs panel and the composer agree", () => {
  // `connect` materializes the managed copy into the CLI tree; take it away again so the rest of
  // the suite sees the same `<cliConfigDir>` it would have seen without this file.
  test.beforeAll(() => {
    forgetCommand();
  });

  test.afterAll(() => {
    forgetCommand();
  });

  test("a command created in the panel is sendable at once, and both surfaces list it", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    await openChat(page);
    await waitForConnection(page);
    await dismissToasts(page);

    // ── 1. CREATE it through the panel's own dialog (the `add` mutation) ──────────────────────
    await openCommandsPanel(page);
    await page.getByRole("button", { name: CREATE_COMMAND }).first().dispatchEvent("click");
    const name = page.getByPlaceholder(NAME_PLACEHOLDER).first();
    await expect(name, "the create dialog's name field").toBeVisible({ timeout: 20_000 });
    await name.fill(CREATED);
    const submit = page.getByRole("button", { name: SUBMIT }).last();
    await expect(submit, "the dialog's submit").toBeEnabled({ timeout: 20_000 });
    await submit.click();
    // The create resolves into the new item's DETAIL card — the panel's own proof that `add`
    // reached the server and came back.
    await expect
      .poll(() => page.getByText(CREATED, { exact: false }).count(), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the panel shows the command the dialog just created",
      })
      .toBeGreaterThan(0);

    // ── 2. CONNECT it globally — an unbound item is deliberately not a composer row ───────────
    await page.getByRole("tab", { name: GLOBAL_TAB }).first().dispatchEvent("click");
    await page.getByRole("button", { name: ADD_TO_SCOPE }).first().dispatchEvent("click");
    // The picker's row is a button whose accessible name is the display name PLUS the description,
    // so it is matched by substring, not anchored.
    const candidate = page.getByRole("button", { name: new RegExp(CREATED) }).first();
    await expect(candidate, "the new command is offered by the «Добавить» picker").toBeVisible({
      timeout: 30_000,
    });
    await candidate.click();
    await expect
      .poll(() => globalTabNames(page).then((names) => names.includes(CREATED)), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the «Глобально» tab lists the command it just connected",
      })
      .toBe(true);
    await closeCommandsPanel(page);
    await dismissToasts(page);

    // ── 3. SEND IT, with no reload. The submit guard's allowlist comes from the SAME seam ─────
    const baseline = promptsSeen().filter((prompt) => prompt === `/${CREATED}`).length;
    await clearComposer(page);
    await focusComposer(page);
    await page.keyboard.type(`/${CREATED} `, { delay: 10 });
    await expect(composer(page)).toContainText(CREATED, { timeout: 20_000 });
    // ONE Enter: a guard that refuses the slug IS "Enter did nothing", and a retry loop would turn
    // that defect into a slow pass (`slashGuard.e2e.test.ts` makes the same choice).
    await page.keyboard.press("Enter");
    await expect
      .poll(() => promptsSeen().filter((prompt) => prompt === `/${CREATED}`).length, {
        timeout: 120_000,
        intervals: [500],
        message: "the CLI was handed the command created moments ago in the panel",
      })
      .toBeGreaterThan(baseline);

    // ── 4. RESCAN (the manual Refresh, which always walks) and compare the two surfaces ───────
    await openCommandsPanel(page);
    const refresh = page.getByLabel(COMMANDS_REFRESH).first();
    await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
    await refresh.dispatchEvent("click");
    await expect
      .poll(() => globalTabNames(page).then((names) => names.includes(CREATED)), {
        timeout: 60_000,
        intervals: [1_000],
        message: "the command survives a full disk walk",
      })
      .toBe(true);
    const panelNames = [...new Set(await globalTabNames(page))].toSorted();
    await closeCommandsPanel(page);
    const menuNames = [...new Set(await composerCommandNames(page))].toSorted();

    saveEvidenceJson("38-catalogs-composer-agree", {
      spec: "catalogsComposerAgree.e2e.test.ts",
      created: CREATED,
      panelNames,
      menuNames,
    });

    expect(menuNames, "the composer offers the command the panel lists").toContain(CREATED);
    expect(panelNames, "and the panel lists it too").toContain(CREATED);
    // EVERY command the composer offers is one the panel knows about. The reverse is legitimately
    // false — a bound-but-DISABLED row stays in the panel, greyed, and is deliberately not offered
    // (`GlobalTab` renders `globallyBoundItems`, the composer filters on `binding.enabled`).
    for (const offered of menuNames) {
      expect(panelNames, `the panel knows every command the composer offers: ${offered}`).toContain(
        offered,
      );
    }
  });
});
