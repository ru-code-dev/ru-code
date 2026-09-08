// ru-code (A10): shared fixtures for the PLUGINS suite.
//
// Everything the seven specs have in common: reading the harness state, the demo plugin's selectors
// (its own `data-testid`s, which is why they are stable), the composer helpers, and the small set of
// page facts that more than one spec asserts.
//
// LOCALE-AGNOSTIC BY CONSTRUCTION. The app boots in Russian and `localeTheme.e2e.test.ts` switches
// it to English and back. Any selector matched on a user-visible STRING therefore accepts both arms
// of the demo's own `L(en, ru)` pairs — a spec that hard-coded one language would pass or fail
// depending on which file Playwright happened to run first.

import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import {
  expect as playwrightExpect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";

import { readPluginsHarnessState, type PluginsHarnessState } from "../harness/pluginsBoot.ts";

export { DEMO_BROKEN_ID, DEMO_HANG_ID, DEMO_ID } from "../harness/pluginsBoot.ts";
export const state = (): PluginsHarnessState => readPluginsHarnessState();

// ── the demo plugin's surface ────────────────────────────────────────────────────────────────

/**
 * Its `L("Demo", "Демо")` pairs, as matchers.
 *
 * ANCHORED where a matcher names ONE node: the footer button's accessible name is exactly the panel
 * label (unanchored would also hit "Demo (broken)" and "Demo (hang)"), and a composer menu ROW's
 * label is a leaf of its own (unanchored would match the row's containers too, and `.first()` would
 * then click an ancestor).
 */
export const DEMO_LABEL = /^(Демо|Demo)$/;
export const DEMO_CONTEXT_LABEL = /^(Демо-контекст|Demo context)$/;
export const DEMO_SKILL_LABEL = /^(Демо-заметки|Demo notes)$/;
export const DEMO_AGENT_LABEL = /^(Демо-ассистент|Demo assistant)$/;
/** UNANCHORED: the composer chip renders the card's source beside its title ("Demo Демо-контекст"). */
export const DEMO_CONTEXT_TEXT = /Демо-контекст|Demo context/;
export const NOTE_ADDED_TOAST = /Заметка добавлена|Note added/;
export const CONTEXT_ATTACHED_TOAST = /Контекст прикреплён|Context attached/;
/** `failedToLoadTitle()` in `apps/web/src/ru-code/plugins/loadPlugins.ts`, both arms. */
export const PLUGIN_FAILED_TOAST = /не загрузился|failed to load/i;

export const COMPOSER = 'div[contenteditable="true"]';

/** The footer button the plugin's `registerPanel({ label })` produced (label = aria-label + tooltip). */
export const demoFooterButton = (page: Page): Locator =>
  page.getByRole("button", { name: DEMO_LABEL }).first();
export const demoPanel = (page: Page): Locator => page.locator('[data-testid="demo-panel"]');
export const demoStatus = (page: Page): Locator => page.locator('[data-testid="demo-status"]');
export const composer = (page: Page): Locator => page.locator(COMPOSER).first();
/** The command menu list `ComposerCommandMenu` renders for `/`, `$` and `#`. */
export const commandMenu = (page: Page): Locator =>
  page.locator('[cmdk-list], [data-slot="command-list"]').first();

// ── page-level helpers ───────────────────────────────────────────────────────────────────────

/**
 * Open the app and wait until the DEMO PLUGIN is on screen.
 *
 * Two predicates, in order, and the order is the point: the app's own sidebar first (the app must
 * render without waiting for any plugin — A4 findings H2/M2), then the plugin's footer icon. Waiting
 * only for the icon would hide a regression that made the whole boot block on `loadPlugins()`.
 */
export async function openAppWithDemo(page: Page): Promise<void> {
  await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });
  await playwrightExpect(
    page.getByRole("button", { name: /^(Настройки|Settings)$/ }).first(),
  ).toBeAttached({ timeout: 30_000 });
  await playwrightExpect(demoFooterButton(page)).toBeAttached({ timeout: 30_000 });
}

/**
 * Wait until the app's environment connection is READY, read off the plugin's own status line.
 *
 * `plugin.invoke` is dispatched to the primary environment, so an RPC issued while the connection is
 * still coming up rejects with `plugin-failed — <env>: нет подключения`. The panel mounts and calls
 * `notes.list` immediately, which means the FIRST list legitimately races the connection on a cold
 * page. The status line is the perfect predicate for it: `host.hooks.useConnectionPhase()` is the
 * app's own hook, rendered by the plugin, so waiting on it is waiting on the exact fact the RPC
 * needs — and it costs the suite no knowledge of the app's connection internals.
 *
 * Requires the panel to be open.
 */
export async function waitForPluginConnection(page: Page): Promise<void> {
  await playwrightExpect
    .poll(
      () =>
        demoStatus(page)
          .innerText()
          .catch(() => ""),
      {
        timeout: 60_000,
        message: "the app's environment connection reaches `ready`",
      },
    )
    .toMatch(/(соединение|connection)\s+ready/);
}

/**
 * The footer icon TOGGLES the panel, so opening it twice would close it.
 *
 * Opening also settles the panel into a USABLE state, which takes two steps a user takes too:
 *
 *  1. wait for the environment connection ({@link waitForPluginConnection});
 *  2. press REFRESH until the list loads. A13 fixed the demo's own half of this (A10 finding P3):
 *     `DemoPanel` now gates its first `notes.list` on `useConnectionPhase() === "ready"` and loads
 *     by itself, so on a healthy run this loop settles on the FIRST tick with no click at all. It
 *     is kept because the predicate — "the panel is showing notes, not an error" — is what every
 *     later assertion actually needs, and because a transient RPC failure for any other reason
 *     should be retried rather than turned into a red spec.
 */
export async function openDemoPanel(page: Page): Promise<void> {
  if (
    !(await demoPanel(page)
      .isVisible()
      .catch(() => false))
  ) {
    await toggleDemoPanel(page);
    await playwrightExpect(demoPanel(page)).toBeVisible({ timeout: 20_000 });
  }
  await waitForPluginConnection(page);
  let lastError = "";
  try {
    await playwrightExpect
      .poll(
        async () => {
          lastError = await demoErrorText(page);
          if (lastError === "") return true;
          await clickPanelControl(page, "demo-refresh").catch(() => undefined);
          return false;
        },
        {
          timeout: 60_000,
          intervals: [1_000],
          message: "the panel's notes.list succeeds once the connection is up (refresh retried)",
        },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `the demo panel never loaded its notes; the panel says: ${lastError === "" ? "(nothing)" : lastError}`,
      { cause: error },
    );
  }
}

export async function closeDemoPanel(page: Page): Promise<void> {
  if (
    !(await demoPanel(page)
      .isVisible()
      .catch(() => false))
  )
    return;
  await toggleDemoPanel(page);
  await playwrightExpect(demoPanel(page)).toBeHidden({ timeout: 20_000 });
}

/**
 * Press the plugin's footer icon.
 *
 * A REAL pointer click first — that the icon is reachable and clickable is part of what spec 2
 * claims — with a bounded fallback to `dispatchEvent` for the moments a toast is parked over it
 * (see {@link clickPanelControl} for the underlying defect).
 */
async function toggleDemoPanel(page: Page): Promise<void> {
  const button = demoFooterButton(page);
  await playwrightExpect(button).toBeVisible({ timeout: 20_000 });
  const clicked = await button
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await button.dispatchEvent("click");
}

/** The note bodies the panel currently lists, newest first (the server's `ORDER BY`). */
export const demoNoteBodies = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".ru-demo-note-body")].map((node) => node.textContent ?? ""),
  );

/**
 * The panel's own failure line, when it has one.
 *
 * `DemoPanel` renders `[data-testid="demo-error"]` from the `PluginRpcError` the host rejects an
 * `invoke` with, so a note that does not appear has a REASON on screen — and a failure that quotes
 * it ("plugin-failed — …") is diagnosable, where a bare "expected [] to contain …" is not.
 */
export const demoErrorText = async (page: Page): Promise<string> => {
  // `count()` FIRST, and never a bare `innerText()`. `innerText()` on a locator that matches
  // nothing does not return "" — it waits for the element for the full 30 s default action
  // timeout. Inside a poll that made every "no error" tick take half a minute, so a retry loop
  // built on it retried roughly twice per minute and looked like the app was broken.
  const locator = page.locator('[data-testid="demo-error"]');
  if ((await locator.count()) === 0) return "";
  return await locator
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => "");
};

/**
 * Click one of the demo panel's own controls.
 *
 * `dispatchEvent("click")` rather than a real pointer click, and NOT for convenience: the app's
 * toast portal renders OVER the plugin panel and intercepts pointer events on its buttons, so the
 * success toast a note raises blocks the next click on `demo-add` for as long as it is on screen
 * (reported as a product finding in `WORKFLOW/reports/A10-e2e-and-docs.md`). Hit-testing the app's
 * z-order is not what these specs are for, and the repo already uses this idiom for exactly this
 * class of interception (`tests-core/fixtures.ts` on the New-thread button). Visibility and enabled
 * state are still asserted first, so a control that is genuinely dead still fails.
 */
export async function clickPanelControl(page: Page, testId: string): Promise<void> {
  const control = page.locator(`[data-testid="${testId}"]`).first();
  await playwrightExpect(control).toBeVisible({ timeout: 20_000 });
  await playwrightExpect(control).toBeEnabled({ timeout: 20_000 });
  await control.dispatchEvent("click");
}

/** Add one note through the panel and wait for the list to carry it. */
export async function addDemoNote(page: Page, body: string): Promise<void> {
  await page.locator('[data-testid="demo-input"]').fill(body);
  await clickPanelControl(page, "demo-add");
  try {
    await playwrightExpect
      .poll(() => demoNoteBodies(page), { timeout: 20_000, message: `note "${body}" is listed` })
      .toContain(body);
  } catch (error) {
    const reason = await demoErrorText(page);
    throw new Error(
      `addDemoNote("${body}") never showed up in the list` +
        (reason === "" ? " (the panel shows no error)" : `; the panel says: ${reason}`),
      { cause: error },
    );
  }
}

/** Remove every note the panel lists, so a spec starts from a known database. */
export async function clearDemoNotes(page: Page): Promise<void> {
  for (let guard = 0; guard < 30; guard += 1) {
    const buttons = page.locator('[data-testid^="demo-remove-"]');
    const count = await buttons.count();
    if (count === 0) return;
    const before = count;
    const testId = await buttons.first().getAttribute("data-testid");
    await clickPanelControl(page, testId ?? "demo-remove-0");
    await playwrightExpect
      .poll(() => page.locator('[data-testid^="demo-remove-"]').count(), {
        timeout: 20_000,
        message: "the removed note leaves the list",
      })
      .toBeLessThan(before);
  }
  throw new Error("clearDemoNotes: the list never emptied");
}

/**
 * Put the caret in the composer.
 *
 * A real click first, BOUNDED, with a `focus()` fallback: after the server restart the uninstall
 * spec performs, the reconnect banner and the app's own overlays can sit over the composer for a
 * while, and Playwright's default action timeout is "wait forever" — an unbounded click there
 * parked the whole spec until its test timeout.
 */
export async function focusComposer(page: Page): Promise<void> {
  const input = composer(page);
  await playwrightExpect(input).toBeVisible({ timeout: 30_000 });
  const clicked = await input
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await input.evaluate((node) => (node as HTMLElement).focus());
}

export async function clearComposer(page: Page): Promise<void> {
  const input = composer(page);
  await focusComposer(page);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await playwrightExpect
    .poll(() => input.innerText().then((text) => text.trim()), {
      timeout: 10_000,
      message: "the composer is empty",
    })
    .toBe("");
}

/**
 * The command menu's text, or `"(no menu)"` when there is no menu.
 *
 * `count()` first, for the same reason {@link demoErrorText} does it: `innerText()` on a locator
 * that matches nothing waits out the 30 s default action timeout instead of answering. "There is no
 * menu" is a legitimate — and, after an uninstall, the EXPECTED — answer, so it must be cheap.
 */
export async function commandMenuText(page: Page): Promise<string> {
  const menu = commandMenu(page);
  if ((await menu.count()) === 0) return "(no menu)";
  return await menu.innerText({ timeout: 2_000 }).catch(() => "(no menu)");
}

/** Type a trigger into the composer and wait for the command menu to be on screen. */
export async function typeTrigger(page: Page, trigger: string): Promise<void> {
  await clearComposer(page);
  await focusComposer(page);
  await page.keyboard.type(trigger, { delay: 40 });
  await playwrightExpect(commandMenu(page)).toBeVisible({ timeout: 20_000 });
}

/** A chat surface: a `/draft/<id>` wizard, or a real `/<environmentId>/<threadId>` thread. */
const CHAT_URL = /\/draft\/|\/[0-9a-f-]{36}\/[0-9a-f-]{36}/;

/**
 * Open a CHAT, which is what gives the composer an ACTIVE TARGET — `composer.attach` is a no-op
 * without one, so the demo's "+" button stays disabled until this has happened.
 *
 * Either surface will do, and which one the app lands on is not this suite's business: with a
 * bootstrapped starter project the root route restores into the starter THREAD a second or two
 * after load, and "New thread" then reuses that empty thread rather than minting a `/draft/`.
 * `useActiveTarget()` answers for both (a draft id, or an `{ environmentId, threadId }` pair) —
 * pinning one of them would be testing the app's thread-reuse policy, not the plugin seam. So:
 * give the app its own restore a moment, and only start a thread when it lands nowhere.
 */
export async function openChat(page: Page): Promise<void> {
  await openAppWithDemo(page);
  await playwrightExpect(composer(page)).toBeVisible({ timeout: 30_000 });
  const restored = await page
    .waitForURL(CHAT_URL, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!restored) {
    await page
      .getByRole("button", { name: /New thread|Новый диалог|Новый поток/ })
      .first()
      // A real pointer click is intercepted by the hover-revealed header menu (the same reason
      // `tests-core/fixtures.ts` uses dispatchEvent here).
      .dispatchEvent("click");
    await playwrightExpect(page).toHaveURL(CHAT_URL, { timeout: 30_000 });
  }
  await playwrightExpect(composer(page)).toBeVisible({ timeout: 30_000 });
}

// ── raw HTTP facts (the specs assert the ROUTE, not only the rendered result) ─────────────────

export interface PluginManifestRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: "loaded" | "failed" | "skipped";
  readonly hasWeb: boolean;
  readonly hasServer: boolean;
  readonly web?: string;
  readonly styles?: string;
  readonly error?: string;
}

export async function fetchManifests(): Promise<ReadonlyArray<PluginManifestRow>> {
  const response = await fetch(`${state().webUrl}/plugins/manifests.json`);
  if (!response.ok) throw new Error(`manifests.json → ${String(response.status)}`);
  return (await response.json()) as ReadonlyArray<PluginManifestRow>;
}

/** Status of a GET against the app. */
export const statusOf = async (path: string): Promise<number> =>
  (await fetch(`${state().webUrl}${path}`, { redirect: "manual" })).status;

/**
 * Status of a GET whose path is sent BYTE FOR BYTE.
 *
 * `fetch` builds a `URL`, and a `URL` normalises `..` segments away before anything is sent — so
 * `fetch("/plugins/demo/web/../../../etc/passwd")` asks the server for `/etc/passwd` and measures the
 * SPA fallback instead of the plugin route's containment check. `node:http` writes the request line
 * verbatim, which is the only way to put a literal `..` on the wire (and the only shape a real
 * attacker's client would send).
 */
export function rawStatusOf(path: string): Promise<number> {
  const url = new URL(state().webUrl);
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      { host: url.hostname, port: url.port, method: "GET", path },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

// ── the app's own event store (delivery proof) ────────────────────────────────────────────────

/**
 * Rows of `projection_thread_messages.text` that contain `needle`.
 *
 * The app's projection is the same place `tests-core` reasons about a delivered turn from, and it is
 * the only source that shows what was actually SENT rather than what is rendered: a context card is
 * merged into the user message's text at send time, so an assertion on the DOM alone cannot tell an
 * attached card from a delivered one.
 */
export async function deliveredMessagesContaining(needle: string): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const file = NodePath.join(state().stateDir, "state.sqlite");
  if (!NodeFS.existsSync(file)) return [];
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT text AS value FROM projection_thread_messages WHERE text LIKE ?")
      .all(`%${needle}%`)
      .map((row) => String((row as { value: unknown }).value));
  } finally {
    database.close();
  }
}

/** Read the plugin's OWN SQLite file (D2) — used to prove D11 keeps it after an uninstall. */
export async function readPluginDatabase(pluginId: string): Promise<{
  readonly path: string;
  readonly exists: boolean;
  readonly migrations: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}> {
  const file = NodePath.join(state().stateDir, "plugins", pluginId, "data.sqlite");
  if (!NodeFS.existsSync(file)) {
    return { path: file, exists: false, migrations: [], notes: [] };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      path: file,
      exists: true,
      migrations: database
        .prepare("SELECT id FROM _plugin_migrations ORDER BY id")
        .all()
        .map((row) => String((row as { id: unknown }).id)),
      notes: database
        .prepare("SELECT body FROM notes ORDER BY created_at DESC, id DESC")
        .all()
        .map((row) => String((row as { body: unknown }).body)),
    };
  } finally {
    database.close();
  }
}

export const test = base;
export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
