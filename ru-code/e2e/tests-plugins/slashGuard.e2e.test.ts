// ru-code v2 (V2-25, S11) — THE SUBMIT GUARD AND A PLUGIN'S `/` COMMANDS, end to end.
//
// THE DEFECT THIS FILE EXISTS FOR. `resolveQwenSubmitPrompt` aborts a message that opens with an
// unknown `/command` (qwen answers one over ACP with a raw -32603), and the allowlist it takes is
// derived from the composer seam: `ChatView` calls `useQwenPluginCommandSlugs()` →
// `usePluginComposerRows("/", "")` → `composer.items("/", "", ctx)`. Before V2-25 that runner's
// effect was keyed on `(plugins, trigger, query)` alone — three inputs the HOST owns, none of which
// moves when a plugin's own data does. The catalogs plugin answers out of an atom it fills over its
// own transport, so the answer the guard took at chat mount was frozen there: a command the user
// added afterwards was refused at send time until the view was remounted.
//
// WHAT MAKES THAT A DETERMINISTIC TEST. The guard's answer is re-taken whenever the plugin REGISTRY
// changes or the chat remounts, and both happen a few times in the first seconds of a page — which
// is why the symptom reads as "it starts working at some point". So every claim here is made AFTER
// the page has settled: the catalog is changed with the app open, through the Commands panel's own
// Refresh, which is the user's own way of doing it. Nothing else can re-ask the seam at that point
// except the plugin telling the host — which is the whole of `ctx.invalidate("composer")`.
//
// `primeCatalog` is "the single seam every rescan/mutation funnels through"
// (`qwen-cli-catalog-core/src/web/catalogAtoms.ts:98`), so the Refresh, the boot resync and a panel
// mutation are one path, and the plugin watches the atom rather than the call sites
// (`plugin-catalogs/src/web/background.tsx` `CatalogInvalidateBridge`).
//
// THE GROUND TRUTH IS THE CLI'S OWN LOG. `fake-acp-server.ts:323` writes `prompt text: <what it
// received>` for every turn, so "the message was sent" and "the `/slug` survived the guard" are one
// fact read off the provider's side of the wire, not a DOM inference. The composer is asserted too,
// because that is what a user sees: `resolveQwenSubmitPrompt`'s `abort` returns before the composer
// is cleared, leaving the text sitting in it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  clearComposer,
  closeDemoPanel,
  composer,
  expect,
  focusComposer,
  openChat,
  openDemoPanel,
  state,
  test,
  type Page,
} from "./fixtures.ts";
import { PLUGINS_ARTIFACTS_DIR } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

/** Written with the chat already open, and brought in by the panel's own Refresh. */
const LIVE_COMMAND = "e2elive";
/** Seeded before any page load here, so a page's boot resync is what brings it in. */
const BOOT_COMMAND = "e2eboot";

/** The Commands panel — `aria-label` is the panel label (`SidebarChrome.tsx`). */
const COMMANDS_LABEL = /^(Менеджер Команд|Command manager)$/;
/** `commandUi.ts:62` `labels.refreshAria`, both arms of the localization swap. */
const COMMANDS_REFRESH = /^(Обновить команды|Refresh commands)$/;

const commandFile = (name: string): string =>
  NodePath.join(state().cliConfigDir, "commands", `${name}.toml`);

const seedCommand = (name: string): void => {
  const file = commandFile(name);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    `description = "The e2e ${name} command."\nprompt = "Do the e2e thing."\n`,
    "utf8",
  );
};

/**
 * Every prompt the fake CLI has been handed, in order.
 *
 * The file accumulates across every boot of the run, so a case takes a baseline and counts rather
 * than merely finding — two of the shapes below send the same bytes.
 */
const promptsSeen = (): ReadonlyArray<string> => {
  const file = NodePath.join(PLUGINS_ARTIFACTS_DIR, "fake-acp.log");
  if (!NodeFS.existsSync(file)) return [];
  return [...NodeFS.readFileSync(file, "utf8").matchAll(/^.*? prompt text: (.*)$/gm)].map(
    (match) => match[1] ?? "",
  );
};

/** Wait for the app's environment connection, off the demo plugin's own `ctx.connection` line. */
const waitForConnection = async (page: Page): Promise<void> => {
  await openDemoPanel(page);
  await closeDemoPanel(page);
};

/** Dismiss the toasts the harness's broken fixtures park over the right-hand slot. */
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

/**
 * Open the Commands panel, press its Refresh, and wait for `name` to be listed.
 *
 * This is the user's own "I just added a command" gesture, and the point of the whole file: the
 * rescan it runs writes the plugin's catalog atom while the chat is open and already mounted.
 */
const refreshCommandsPanel = async (page: Page, name: string): Promise<void> => {
  const button = page.getByRole("button", { name: COMMANDS_LABEL }).first();
  await expect(button, "the plugin's footer entry is on the rail").toBeVisible({ timeout: 30_000 });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await button.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: /^(Каталог|Catalog)$/ }).first()).toBeVisible({
    timeout: 30_000,
  });

  const refresh = page.getByLabel(COMMANDS_REFRESH).first();
  await expect(refresh, "the panel's refresh control").toBeVisible({ timeout: 20_000 });
  await refresh.dispatchEvent("click");
  await expect
    .poll(() => page.getByText(name, { exact: false }).count(), {
      timeout: 60_000,
      intervals: [1_000],
      message: `the panel lists ${name} after its own refresh`,
    })
    .toBeGreaterThan(0);

  // Close it again: the panel must not be what keeps the rows alive.
  await button.dispatchEvent("click");
  await expect(page.getByRole("tab", { name: /^(Каталог|Catalog)$/ })).toHaveCount(0, {
    timeout: 20_000,
  });
};

/**
 * Type `text` and press Enter ONCE.
 *
 * Deliberately not `tests-core`'s `sendPrompt`, which retries Enter until the composer empties: a
 * guard that aborts the submit IS "Enter did nothing", and a helper that retries would turn the
 * defect under test into a slow pass.
 */
const typeAndEnter = async (page: Page, text: string): Promise<void> => {
  await clearComposer(page);
  await focusComposer(page);
  await page.keyboard.type(text, { delay: 10 });
  await expect(composer(page)).toContainText(text.slice(-12), { timeout: 20_000 });
  await page.keyboard.press("Enter");
};

const composerText = async (page: Page): Promise<string> =>
  (await composer(page)
    .textContent()
    .catch(() => "")) ?? "";

/** Assert `text` reached the CLI, and that the composer let go of it. */
const expectDelivered = async (
  page: Page,
  text: string,
  baseline: ReadonlyArray<string>,
): Promise<void> => {
  const wanted = baseline.filter((prompt) => prompt === text).length + 1;
  await expect
    .poll(() => promptsSeen().filter((prompt) => prompt === text).length, {
      timeout: 120_000,
      intervals: [500],
      message: `the CLI was handed ${JSON.stringify(text)} (${String(wanted)} time(s) in total)`,
    })
    .toBeGreaterThanOrEqual(wanted);
  expect(await composerText(page), "and the composer let go of it").not.toContain(text.slice(-12));
};

test.describe("plugins — the qwen submit guard sees a plugin's `/` commands", () => {
  test.beforeAll(() => {
    seedCommand(BOOT_COMMAND);
  });

  test.afterAll(() => {
    for (const name of [LIVE_COMMAND, BOOT_COMMAND]) {
      NodeFS.rmSync(commandFile(name), { force: true });
    }
  });

  test("a command added with the chat OPEN is sendable in all three shapes", async ({ page }) => {
    test.setTimeout(300_000);
    await openChat(page);
    await waitForConnection(page);
    await dismissToasts(page);

    // Written with the page already live and settled. Nothing the HOST owns will move again: the
    // plugins are all loaded, the chat is mounted, the connection is up.
    seedCommand(LIVE_COMMAND);
    await refreshCommandsPanel(page, LIVE_COMMAND);
    await dismissToasts(page);

    // (b) BARE, no trailing space — the shape the defect was reported as. The `/` menu is open on
    // this shape (`detectComposerTrigger`: `/^\/(\S*)$/`), so the first Enter takes the highlighted
    // row — which only exists if the plugin's rows reached the menu — completing the text to
    // `/e2elive `; the second Enter submits it through the guard.
    const bareBaseline = promptsSeen();
    await clearComposer(page);
    await focusComposer(page);
    await page.keyboard.type(`/${LIVE_COMMAND}`, { delay: 10 });
    await expect(composer(page)).toContainText(LIVE_COMMAND, { timeout: 20_000 });
    await saveEvidenceScreenshot(page, "slash-guard-menu");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expectDelivered(page, `/${LIVE_COMMAND}`, bareBaseline);

    // (c) WITH THE TRAILING SPACE — no trigger, so no menu, so this Enter is the guard's decision
    // and nothing else.
    const spacedBaseline = promptsSeen();
    await typeAndEnter(page, `/${LIVE_COMMAND} `);
    await expectDelivered(page, `/${LIVE_COMMAND}`, spacedBaseline);

    // (d) WITH ARGUMENTS — the sharpest of the three: an unknown slug with trailing text is not
    // aborted, it is STRIPPED, so a stale allowlist delivers `with arguments` and loses the command
    // silently. What must arrive is the line the user typed, `/slug` included.
    const argsText = `/${LIVE_COMMAND} with arguments`;
    const argsBaseline = promptsSeen();
    await typeAndEnter(page, argsText);
    await expectDelivered(page, argsText, argsBaseline);
    expect(
      promptsSeen(),
      "the guard never stripped the slug and sent the arguments alone",
    ).not.toContain("with arguments");

    saveEvidenceJson("slash-guard-live-command", {
      spec: "slashGuard.e2e.test.ts",
      claim: "a catalog change made with the chat open reaches the submit allowlist (V2-25)",
      file: commandFile(LIVE_COMMAND),
      prompts: promptsSeen().slice(-6),
    });
  });

  test("a boot whose transport comes up late still sends on the FIRST Enter after connect", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // THE ORDERING, FORCED. Holding the app's websocket back means the page paints, the plugins
    // load and every seam is asked with the transport DOWN — which is the state
    // `primeCatalogOnce` refuses to fetch in. Nothing else about the run is mocked: the socket is
    // connected to the real server, just later.
    const delayMs = 8_000;
    await page.routeWebSocket(/.*/, async (ws) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      ws.connectToServer();
    });

    const openedAt = Date.now();
    await openChat(page);
    await waitForConnection(page);
    const connectedAfterMs = Date.now() - openedAt;
    expect(
      connectedAfterMs,
      "the connection really did come up after the page had been live a while",
    ).toBeGreaterThan(delayMs);
    await dismissToasts(page);

    const text = `/${BOOT_COMMAND} after a slow connect`;
    const baseline = promptsSeen();
    await typeAndEnter(page, text);
    await expectDelivered(page, text, baseline);

    saveEvidenceJson("slash-guard-slow-connect", {
      spec: "slashGuard.e2e.test.ts",
      delayMs,
      connectedAfterMs,
      sent: text,
      prompts: promptsSeen().slice(-4),
    });
  });
});
