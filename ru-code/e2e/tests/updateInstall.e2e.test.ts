// ru-code: auto-update e2e — the install run (#41d), against the REAL app + the
// mock WEB update source + a real release tarball, in a real sandbox layout
// (RU_CODE_APP_ROOT). Pressing «Установить» downloads the tarball, verifies its
// sha256 + per-file checksums, extracts it into versions/<v>, flips the pointer
// and journals `started`, then reaches the `restart` phase — where, under
// RU_CODE_UPDATE_TEST_NO_RELAUNCH, the run STOPS (the dev server is never actually
// relaunched). The press NEVER leaves the settings page (F13): the hero itself
// becomes the run view. That leaves the engine's run stuck at `restart`, so this
// spec lives in its OWN file whose name sorts LAST (after smoke/messageFlow/
// autoUpdate) and runs a single test, so it can never poison another spec's page.
//
// Selectors are URL + data-testid only; filesystem facts are read straight off the
// sandbox appRoot the harness created.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Page } from "@playwright/test";

import {
  expect,
  readHarnessState,
  readMockRequestCount,
  setMockUpdateMode,
  test,
} from "./fixtures.ts";

const state = () => readHarnessState();

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SETTINGS_URL = () => `${state().webUrl}/settings/auto-update`;

// Reload-tolerant helpers (same shape as autoUpdate.e2e.test.ts): the subscription
// can take a while on a fresh page and, in a mac-mounted dev sandbox, the
// `node --watch` server can spuriously restart mid-spec. The settings page also
// HIDES the source cards once a source works (advanced/compact), so reveal them via
// «Настроить источники вручную» (auto-update-configure-sources) when needed.
async function ensureSourceCards(page: Page): Promise<void> {
  const web = page.getByTestId("auto-update-source-web");
  await expect(async () => {
    if ((await web.count()) > 0) return;
    const configure = page.getByTestId("auto-update-configure-sources");
    if ((await configure.count()) > 0) await configure.click({ timeout: 8_000 });
    else await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
    await expect(web).toBeVisible({ timeout: 12_000 });
  }).toPass({ timeout: 90_000 });
}

async function driveHeroToAvailable(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("auto-update-hero")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 90_000 });

  // A successful web probe must land FIRST: it makes web work (enables the hero
  // «Проверить») AND unpauses web if an earlier spec (the 401 pause) paused it — a
  // paused web would make the install's re-resolve find no source. Assert on the mock
  // counter (state-independent): mode=release, so the probe returns ok + unpauses.
  const before = readMockRequestCount(state());
  await expect(async () => {
    await ensureSourceCards(page);
    await page.getByTestId("auto-update-probe-web").click({ timeout: 10_000 });
    expect(readMockRequestCount(state())).toBeGreaterThan(before);
  }).toPass({ timeout: 150_000 });

  const hero = page.getByTestId("auto-update-hero");
  await expect(async () => {
    if ((await hero.getAttribute("data-phase")) === "available") return;
    // The hero «Проверить» is enabled once web works; a full tick finds the release.
    if ((await page.getByTestId("auto-update-check").count()) === 0) {
      await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
    }
    await page.getByTestId("auto-update-check").click({ timeout: 10_000 });
    await expect(hero).toHaveAttribute("data-phase", "available", { timeout: 20_000 });
  }).toPass({ timeout: 120_000 });
}

test("pressing «Установить» runs the real install to the restart phase and flips the sandbox pointer (#41d)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  setMockUpdateMode(state(), "release");
  await driveHeroToAvailable(page);

  // Press install: the run starts server-side and THIS card becomes the run view — no
  // navigation, no toast (F13/F14). The URL must still be the settings page afterwards.
  const settingsUrl = page.url();
  await page.getByTestId("auto-update-install").click();
  await expect(page.getByTestId("auto-update-hero")).toHaveAttribute("data-phase", "running", {
    timeout: 30_000,
  });

  // The run advances through the phase timeline and lands on `restart` (the terminal phase
  // under RU_CODE_UPDATE_TEST_NO_RELAUNCH), reported by the hero's inline run block.
  await expect(page.getByTestId("auto-update-run")).toHaveAttribute("data-phase", "restart", {
    timeout: 30_000,
  });
  expect(page.url()).toBe(settingsUrl);

  // Server-side proof: the sandbox pointer was flipped to the new version and the
  // journal recorded a `started` transition.
  const appRoot = state().appRoot;
  const newer = state().newerVersion;

  await expect
    .poll(() => readJsonFile(NodePath.join(appRoot, "current.json"))?.["version"], {
      timeout: 20_000,
    })
    .toBe(newer);

  const journal = readJsonFile(NodePath.join(appRoot, "updates", "journal.json"));
  expect(journal?.["outcome"]).toBe("started");
  expect(journal?.["targetVersion"]).toBe(newer);

  // And the verified version tree landed.
  expect(NodeFS.existsSync(NodePath.join(appRoot, "versions", newer, "cli.js"))).toBe(true);

  // ── the IN-APP restart wait (the tab rides it out; no takeover) ────────────────────────────
  //
  // The hero itself owns the restart window: the timeline sits on its last dot and an elapsed
  // counter climbs, driven by the shared time tick rather than by WS traffic (there is none — the
  // server is supposed to be dying). Under RU_CODE_UPDATE_TEST_NO_RELAUNCH the harness server never
  // actually restarts, so this is the "restart that never completes" case: it must stay honest and
  // stable, never flip to a spinner-with-no-information and never loop.
  const run = page.getByTestId("auto-update-run");
  await expect(run).toHaveAttribute("data-phase", "restart");
  await expect(page.getByTestId("auto-update-run-timeline")).toHaveAttribute(
    "data-phase",
    "restart",
  );

  // The elapsed seconds really advance — read as a data attribute, never as rendered text (the
  // app is Russian; asserting on copy is banned here). It climbs off the shared time tick, which
  // is what keeps it honest while the WS delivers nothing.
  const elapsed = async (): Promise<number> =>
    Number((await run.getAttribute("data-elapsed")) ?? "-1");
  expect(await elapsed()).toBeGreaterThanOrEqual(0);
  await expect.poll(elapsed, { timeout: 20_000 }).toBeGreaterThan(1);
});
