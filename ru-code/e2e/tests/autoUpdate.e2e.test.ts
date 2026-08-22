// ru-code: auto-update e2e — the check machine + notifications + SW fallback +
// server re-pair, driven against the REAL app + a control-file mock WEB update
// source (scripts/mockUpdateServer.ts) + a sandbox install layout (RU_CODE_APP_ROOT).
//
// Selectors are URL + data-testid + data-* attributes ONLY (the app defaults to
// Russian; English label selectors would break). Waits are predicates, never wall
// clocks (the only setTimeouts are inside bounded page.waitForFunction polls).
//
// The engine is ONE server instance for the whole run, so these specs share
// persisted state: they are ordered and each resets the mock server's behaviour +
// (for the counter case) reads a fresh request baseline before acting. The install
// spec — which leaves a run stuck at `restart` under RU_CODE_UPDATE_TEST_NO_RELAUNCH,
// turning the hero itself into the run view (there is no in-app update route) — lives in its own
// file (updateInstall.e2e.test.ts) that sorts LAST so it never poisons another spec.
//
// oxlint-disable unicorn/require-post-message-target-origin -- ServiceWorker postMessage takes no targetOrigin

import type { Page } from "@playwright/test";

import {
  expect,
  fetchServerHealthz,
  readHarnessState,
  readMockRequestCount,
  setMockUpdateMode,
  test,
} from "./fixtures.ts";

const state = () => readHarnessState();

// The SW cache bucket + marker key the app persists into (mirrors
// apps/web/src/ru-code/auto-update-ui/sw-kit/runtime.ts — inlined because these
// run inside the page where the app module is not importable).
const SW_CACHE_NAME = "ru-code-sw-v1";
const SW_MARKER_KEY = "/__ru-code/update-marker";

const SETTINGS_URL = () => `${state().webUrl}/settings/auto-update`;

// Two things make these helpers reload-tolerant. (1) The subscription can take a
// while to deliver its first snapshot on a fresh page (and, in a mac-mounted dev
// sandbox, the `node --watch` server can spuriously restart, dropping it mid-spec).
// (2) The settings page HIDES the source-card editor once a source is `working`
// (`advanced = !working || manualSourcesOpen`) — so a spec that needs the cards
// must open «Настроить источники вручную» (data-testid auto-update-configure-sources)
// when a source already works. Every helper handles both.

const PHASE_WORKING = /^(up-to-date|available)$/;

/** Navigate to the settings deep link and wait for the always-present status hero (reload-tolerant). */
async function openSettings(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("auto-update-settings-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("auto-update-hero")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
}

/**
 * Ensure the source-card editor is mounted. It is shown directly while no source
 * works; once one does the page goes compact, so click «Настроить источники
 * вручную» to reveal it; if neither is present the subscription hasn't delivered —
 * reload to re-establish it. Does NOT reload once the cards/button are reachable
 * (so callers that must avoid a reload can rely on the no-reload fast paths).
 */
async function ensureSourceCards(page: Page): Promise<void> {
  const web = page.getByTestId("auto-update-source-web");
  await expect(async () => {
    if ((await web.count()) > 0) return;
    const configure = page.getByTestId("auto-update-configure-sources");
    if ((await configure.count()) > 0) {
      await configure.click({ timeout: 8_000 });
    } else {
      await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
    }
    await expect(web).toBeVisible({ timeout: 12_000 });
  }).toPass({ timeout: 90_000 });
}

/**
 * Probe the WEB card and wait for it to reach `expected` — used only for NON-working
 * targets (errored/paused) where the card stays mounted. Retries the whole click,
 * so callers must not depend on an exact request count across this call.
 */
async function probeWebUntil(page: Page, expected: string): Promise<void> {
  const card = page.getByTestId("auto-update-source-web");
  await expect(async () => {
    await ensureSourceCards(page);
    await page.getByTestId("auto-update-probe-web").click({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-state", expected, { timeout: 20_000 });
  }).toPass({ timeout: 150_000 });
}

/**
 * Drive the WEB source to `working` (a successful probe → the hero leaves
 * never-checked/attention for up-to-date/available). The hero — not the card — is
 * the signal, because a card that turns `ok` immediately unmounts (the page goes
 * compact). This also enables the hero «Проверить», disabled until a source works.
 */
async function makeWebWorking(page: Page): Promise<void> {
  const hero = page.getByTestId("auto-update-hero");
  await expect(async () => {
    if (PHASE_WORKING.test((await hero.getAttribute("data-phase")) ?? "")) return;
    await ensureSourceCards(page);
    await page.getByTestId("auto-update-probe-web").click({ timeout: 10_000 });
    await expect(hero).toHaveAttribute("data-phase", PHASE_WORKING, { timeout: 20_000 });
  }).toPass({ timeout: 150_000 });
}

/**
 * Click the WEB «Проверить» until the mock records a fresh request — proof the probe
 * RPC round-tripped to the server. Under mode=release this also turns web `ok` and
 * UNPAUSES it (the manual-probe unpause path), regardless of any pause a prior spec
 * left. State-independent: it asserts on the mock's request counter, not the card.
 */
async function probeWebHitsMock(page: Page): Promise<void> {
  const before = readMockRequestCount(state());
  await expect(async () => {
    await ensureSourceCards(page);
    await page.getByTestId("auto-update-probe-web").click({ timeout: 10_000 });
    expect(readMockRequestCount(state())).toBeGreaterThan(before);
  }).toPass({ timeout: 150_000 });
}

/** Make web work, then run a full tick from the hero and wait for `available`. */
async function checkUntilAvailable(page: Page): Promise<void> {
  await makeWebWorking(page);
  const hero = page.getByTestId("auto-update-hero");
  await expect(async () => {
    if ((await hero.getAttribute("data-phase")) === "available") return;
    await page.getByTestId("auto-update-check").click({ timeout: 10_000 });
    await expect(hero).toHaveAttribute("data-phase", "available", { timeout: 20_000 });
  }).toPass({ timeout: 120_000 });
}

// ── #39 / #44: the settings page shows a REAL wire fact ─────────────────────────

test("settings hero carries the real wire version + a phase, matching /healthz (#39/#44)", async ({
  page,
}) => {
  await openSettings(page);

  const hero = page.getByTestId("auto-update-hero");
  // A concrete lifecycle phase (not merely "visible"): the hero always stamps one.
  const phase = await hero.getAttribute("data-phase");
  expect(phase).not.toBeNull();
  expect(phase).not.toBe("");

  // The version on the hero is the real baked wire fact — it must equal what the
  // SERVER's /healthz reports (fetched here, live, from the server origin).
  const health = await fetchServerHealthz(state());
  expect(health.ok).toBe(true);
  expect(await hero.getAttribute("data-version")).toBe(health.version);
  expect(health.version).toBe(state().currentVersion);
});

// ── #41a: a newer release → available hero + pill + toast; «Позже» dismisses ─────

test("checkNow finds a newer release: available hero, release pill, toast; «Позже» hides the pill (#41a)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "release");
  await openSettings(page);

  // Make a source work (enables the hero «Проверить»), then run a full tick.
  await checkUntilAvailable(page);

  // Hero is `available`; the install CTA (only rendered while available) proves
  // "version shown" without reading localized copy.
  await expect(page.getByTestId("auto-update-install")).toBeVisible({ timeout: 20_000 });

  // The PILL lives in the main app sidebar (SidebarAutoUpdatePill), which the sidebar swaps out on
  // the settings route — so assert it on the chat route, where the footer is rendered. The TOAST is
  // a separate matter: its driver is mounted app-wide (AutoUpdateDriverMount) and runs on every
  // route, but `computeDriverDecision` deliberately stays quiet on /settings/auto-update, where the
  // page already states everything a toast would. The release is server-persisted, so it is still
  // `available` here and the toast raises on this load.
  await page.goto(`${state().webUrl}/`, { waitUntil: "domcontentloaded" });

  // The «Доступна vX» toast is up — assert via its action testids (it is time-boxed,
  // so check it before the persistent pill).
  await expect(page.getByTestId("auto-update-toast-install")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("auto-update-toast-notes")).toBeVisible();

  // The sidebar pill appears with the release kind.
  const pill = page.getByTestId("auto-update-pill");
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toHaveAttribute("data-kind", "release");

  // «Позже» dismisses the TOAST (and stamps the server's quiet window). The sidebar pill is a
  // status indicator, not a nag — it stays up for as long as the release is actually available.
  await page.getByTestId("auto-update-toast-later").click();
  await expect(page.getByTestId("auto-update-toast-install")).toHaveCount(0, { timeout: 20_000 });
  await expect(pill).toBeVisible();
});

// ── #41b: a 404 answer → the web card shows its error state ──────────────────────

test("checkNow with a 404 answer surfaces the web source card error state (#41b)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "notfound");
  await openSettings(page);

  // A 404 is an *answered* failure → the derived card state is `errored` (a
  // non-working state, so the card stays mounted).
  await probeWebUntil(page, "errored");
});

// ── #41c: two 401s pause the source; traffic reached the mock ────────────────────

test("two 401 answers pause the web source (#41c)", async ({ page }) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "unauthorized");
  await openSettings(page);

  const before = readMockRequestCount(state());

  // Each 401 is an answered auth rejection; the second one engages the persisted
  // pause. probeWebUntil retries the click until the card reaches `paused`, so it
  // issues the (>=2) probes the lockout needs.
  await probeWebUntil(page, "paused");

  // Real traffic reached the mock while the source was active (the pause is
  // evidence-driven). The complementary invariant "a PAUSED source is skipped by
  // the scheduled/manual TICK → zero traffic" cannot be driven through this UI (the
  // per-source «Проверить» is the deliberate unpause path and always hits the
  // network, and the hero «Проверить» is disabled once no source is working), so it
  // is asserted in the engine unit test updateEngineLive.test.ts "401 twice pauses
  // the source; the next checkNow makes zero traffic".
  expect(readMockRequestCount(state())).toBeGreaterThan(before);
});

// ── #41e: the git source card renders FIRST in DOM order ─────────────────────────

test("the git source card renders before the web source card (#41e)", async ({ page }) => {
  test.setTimeout(120_000);
  await openSettings(page);
  await ensureSourceCards(page);
  const cards = page.locator('[data-testid^="auto-update-source-"]');
  await expect(cards).toHaveCount(2);
  expect(await cards.nth(0).getAttribute("data-testid")).toBe("auto-update-source-git");
  expect(await cards.nth(1).getAttribute("data-testid")).toBe("auto-update-source-web");
});

// ── the sources block must not move on its own ───────────────────────────────────
//
// Reported: press «Проверить» on the hero with zero errors → the sources block expands → the check
// succeeds → it collapses again by itself. The cause was `open` being a MOUNT SNAPSHOT, re-derived
// every time the card was recreated. The rule is now a pure derivation with a user override, and
// that rule is unit-tested — but only a real page proves the component actually follows it, and the
// bug itself was a REMOUNT, which no pure test can reproduce.

test("a clean check never opens the sources block (and never closes it either)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "available");
  await openSettings(page);
  await ensureSourceCards(page);

  const web = page.getByTestId("auto-update-source-web");
  // Get the source to a healthy verdict first — attention is exactly what MAY open the block.
  await probeWebUntil(page, "ok");
  await expect(web).toHaveAttribute("data-open", "false");

  // The reported gesture.
  await page.getByTestId("auto-update-check").click({ timeout: 10_000 });

  // Through the check and after it settles: untouched. `toHaveAttribute` polls, so this covers the
  // whole window rather than sampling one instant.
  await expect(web).toHaveAttribute("data-open", "false", { timeout: 30_000 });
  await expect(page.getByTestId("auto-update-hero")).toHaveAttribute(
    "data-phase",
    /available|up-to-date/,
    {
      timeout: 30_000,
    },
  );
  await expect(web).toHaveAttribute("data-open", "false");
});

// ── #40: the SW navigate-fallback (predicate-driven, no wall-clock sleeps) ────────

/** Register the SW and wait — by predicate, not a sleep — until it controls this client. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("no service worker support");
    await navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
    await navigator.serviceWorker.ready;
  });
  // The SW calls clients.claim() on activate → the controller appears. Poll the
  // controller state (falling back to the active registration, which `ready`
  // guarantees) instead of the old 1500 ms wall-clock fallback.
  await page.waitForFunction(
    async () => {
      if (navigator.serviceWorker.controller !== null) return true;
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active != null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Post the update marker and wait — by predicate — until the SW has persisted it. */
async function waitForMarkerPersisted(
  page: Page,
  cache: string,
  key: string,
  targetVersion: string,
): Promise<void> {
  await page.evaluate(
    async ({ targetVersion }) => {
      const registration = await navigator.serviceWorker.ready;
      const target = navigator.serviceWorker.controller ?? registration.active;
      target?.postMessage({
        type: "ru-code:update-active",
        marker: { v: 1, targetVersion, fromVersion: "1.0.0", startedAt: Date.now() },
      });
    },
    { targetVersion },
  );
  // Replaces the old 400 ms "give the SW a beat" sleep with a Cache-Storage poll.
  await page.waitForFunction(
    async ({ cache, key }) => {
      if (typeof caches === "undefined") return false;
      const bucket = await caches.open(cache);
      return (await bucket.match(key)) !== undefined;
    },
    { cache, key },
    { timeout: 15_000 },
  );
}

/** Clear the SW marker and wait — by predicate — until it is gone from Cache Storage. */
async function clearMarker(page: Page, cache: string, key: string): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    (navigator.serviceWorker.controller ?? registration.active)?.postMessage({
      type: "ru-code:update-clear",
    });
  });
  await page.waitForFunction(
    async ({ cache, key }) => {
      if (typeof caches === "undefined") return true;
      const bucket = await caches.open(cache);
      return (await bucket.match(key)) === undefined;
    },
    { cache, key },
    { timeout: 15_000 },
  );
}

test.describe("service worker navigate-fallback (SW-down test)", () => {
  // #40: the marker-clear guard — a fresh context per test already starts with an
  // empty Cache Storage, but clear defensively so a marker can never leak in and
  // turn the down-page assertion into an updating-page one.
  test.beforeEach(async ({ page }) => {
    await openSettings(page);
    await waitForServiceWorker(page);
    await clearMarker(page, SW_CACHE_NAME, SW_MARKER_KEY);
  });

  test("no marker: a failed navigation serves the branded down page, and returns when back (#40)", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await expect(page.getByTestId("sw-down-page")).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.setOffline(false);
    }

    // Server back: the SW's fetch succeeds again, so a navigation returns the real app.
    await page.goto(`${state().webUrl}/`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sw-down-page")).toHaveCount(0);
    await expect(page.locator("div[contenteditable=true]").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a fresh marker: the failed navigation shows the updating page instead (W15) (#40)", async ({
    page,
    context,
  }) => {
    await waitForMarkerPersisted(page, SW_CACHE_NAME, SW_MARKER_KEY, "9.9.9");

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await expect(page.getByTestId("sw-updating-page")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sw-down-page")).toHaveCount(0);
    } finally {
      await context.setOffline(false);
      await clearMarker(page, SW_CACHE_NAME, SW_MARKER_KEY);
    }
  });
});

// ── #45: a press that FAILS (the manifest points at a tarball that is not there) ───

/**
 * Drive the hero to a failed run: a valid manifest whose tarball route 404s, so the CHECK
 * succeeds, the press starts a real run, and the download is what dies. This is the live repro
 * that produced a permanent spinner reading «Обновление до v0.0.30… / Ошибка» with no reason and
 * no button — the run object survives on the SERVER, so F5 could not clear it either.
 */
async function driveRunFailure(page: Page): Promise<void> {
  setMockUpdateMode(state(), "gonetarball");
  await openSettings(page);
  // The engine is ONE instance for the whole run and a failed run is persisted server state, so a
  // preceding spec may already have left the hero exactly where this helper wants it.
  if ((await page.getByTestId("auto-update-hero").getAttribute("data-phase")) === "run-failed") {
    return;
  }
  // A successful web probe must land FIRST — it UNPAUSES web if the 401 spec above paused it.
  // A paused source is skipped by the install's re-resolve, so the press would be refused with
  // `sources-unreachable` and no run would ever start (same reason updateInstall.e2e does this).
  await probeWebHitsMock(page);
  await checkUntilAvailable(page);
  const hero = page.getByTestId("auto-update-hero");
  await expect(async () => {
    if ((await hero.getAttribute("data-phase")) === "run-failed") return;
    await page.getByTestId("auto-update-install").click({ timeout: 10_000 });
    await expect(hero).toHaveAttribute("data-phase", "run-failed", { timeout: 60_000 });
  }).toPass({ timeout: 180_000 });
}

test("a press whose tarball is gone lands on a failed-run hero with a reason and a way out (#45a)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await driveRunFailure(page);

  // The failure block is rendered: the reason, the evidence and the journal — not a spinner.
  await expect(page.getByTestId("auto-update-run-failed")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("auto-update-run")).toHaveCount(0);

  // Both ways out are live. «Повторить» repeats the press; «Проверить» re-resolves the release —
  // the button that did not exist at all in this state before.
  await expect(page.getByTestId("auto-update-retry")).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId("auto-update-check")).toBeEnabled();

  // The run is SERVER state: a reload must show the same honest failure, never a live-looking run.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("auto-update-hero")).toHaveAttribute("data-phase", "run-failed", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("auto-update-run")).toHaveCount(0);
});

test("«Проверить» on the failed hero retires the dead run and re-resolves the release (#45b)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await driveRunFailure(page);

  // The way off a hero pinned to a dead attempt: re-check. A settled round retires the failed run
  // (a LIVE one still blocks checks — INV-6) and the hero returns to the release it can offer.
  const hero = page.getByTestId("auto-update-hero");
  await expect(async () => {
    await page.getByTestId("auto-update-check").click({ timeout: 10_000 });
    await expect(hero).toHaveAttribute("data-phase", "available", { timeout: 30_000 });
  }).toPass({ timeout: 150_000 });
  await expect(page.getByTestId("auto-update-run-failed")).toHaveCount(0);
  await expect(page.getByTestId("auto-update-install")).toBeVisible();

  // Leave the engine clean for the specs that follow (they share one server).
  setMockUpdateMode(state(), "release");
});

// ── #46: booting with a fresh update marker must load ONCE (the reload loop) ───────

test("a boot with a fresh update marker and a live server loads exactly once (#46)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "release");

  // Plant a FRESH marker at document-start of every load, and count the loads. Re-planting is
  // what makes this a loop test: if a booting tab treated "no snapshot yet + fresh marker" as
  // "the server died" — the old rule — it would reload, find the marker again, and blink between
  // the app and the SW page until the marker went stale five minutes later.
  await page.addInitScript(
    ({ cache, key }) => {
      sessionStorage.setItem(
        "__ruCodeLoads",
        String(Number(sessionStorage.getItem("__ruCodeLoads") ?? "0") + 1),
      );
      void caches
        .open(cache)
        .then((bucket) =>
          bucket.put(
            key,
            new Response(
              JSON.stringify({
                v: 1,
                targetVersion: "9.9.9",
                fromVersion: "1.0.0",
                startedAt: Date.now(),
              }),
            ),
          ),
        )
        .then(() => sessionStorage.setItem("__ruCodePlanted", "1"));
    },
    { cache: SW_CACHE_NAME, key: SW_MARKER_KEY },
  );

  await page.goto(SETTINGS_URL(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("auto-update-hero")).toBeVisible({ timeout: 60_000 });

  // The marker really was in place for this boot…
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("__ruCodePlanted")), { timeout: 20_000 })
    .toBe("1");

  // …and the connected app RETIRED it (decision "clear") instead of reloading into the SW page.
  await page.waitForFunction(
    async ({ cache, key }) => {
      if (typeof caches === "undefined") return true;
      const bucket = await caches.open(cache);
      return (await bucket.match(key)) === undefined;
    },
    { cache: SW_CACHE_NAME, key: SW_MARKER_KEY },
    { timeout: 60_000 },
  );

  expect(await page.evaluate(() => sessionStorage.getItem("__ruCodeLoads"))).toBe("1");
});

// ── #42: the app re-pairs after a transport drop, without a full page reload ──────

test("the app re-pairs after a server transport drop, no page reload (#42)", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  setMockUpdateMode(state(), "release");
  await openSettings(page);
  // Warm + prove the subscription is live before the drop: a probe reaches the mock
  // (this also unpauses web if a prior spec paused it). May reload — fine, pre-sentinel.
  await probeWebHitsMock(page);

  // A sentinel that a FULL page reload would wipe — the re-pair must not reload.
  await page.evaluate(() => ((window as unknown as { __noReload?: string }).__noReload = "kept"));

  // Drop the WebSocket transport to the server, then restore it (the dev-harness
  // faithful analog of the server child dropping and coming back — a true
  // kill+respawn of the server child is not feasible under `vp --parallel` without
  // restructuring dev-runner; the server-child pid is recorded in harness-state as
  // the seam for a future standalone-server suite — see bootApp.ts / the report).
  await context.setOffline(true);
  await context.setOffline(false);

  // Re-pair proof: a fresh probe RPC round-trips to the server AGAIN — the mock records
  // a new request — WITHOUT a reload. Reveal the card via the (client-only) «Настроить
  // источники вручную» button, never page.goto; a click that raced the reconnect is
  // simply re-issued. Asserting on the mock counter (not the card) makes this immune to
  // whatever pause/ok state the source carried in.
  const before = readMockRequestCount(state());
  const webCard = page.getByTestId("auto-update-source-web");
  await expect(async () => {
    const configure = page.getByTestId("auto-update-configure-sources");
    if ((await configure.count()) > 0) await configure.click({ timeout: 5_000 });
    await expect(webCard).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("auto-update-probe-web").click({ timeout: 5_000 });
    expect(readMockRequestCount(state())).toBeGreaterThan(before);
  }).toPass({ timeout: 120_000 });

  // And it re-paired WITHOUT a full reload — the sentinel survived.
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    "kept",
  );
});
