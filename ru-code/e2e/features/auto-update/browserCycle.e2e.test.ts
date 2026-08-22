// ru-code: THE real-browser auto-update acceptance test (E2E-C, to-do.md §8.3 [L]).
//
// A real chromium tab drives the FULL auto-update cycle on a REAL installed bundle — real clicks,
// a real download→verify→flip→restart run, the real blind window (the old server dies mid-run),
// and the real automatic return onto the new version. Nothing about the update is faked: the only
// env seam in play is RU_CODE_UPDATE_TEST_VERSION_FROM_DIR=1 (so version A and version B can be the
// SAME real build re-versioned, avoiding a second full build). The press is the real authenticated
// WS `install` RPC behind the real button; auth is the production path (open the tokenized URL the
// daemon persists in its runtime-state file — exactly what a real user's first tab does).
//
// The real infrastructure (payload/bundle assembly WITH the built web client, the fixture release
// server, daemon boot/stop, on-disk observation) is shared with the headless suite via ../shared.ts;
// the installed tree itself is laid down by the shipped `install` script (harness/installScript.ts).
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off

import { expect, test, type Page } from "@playwright/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { releaseTarballName } from "../../../branding/src/index.ts";

import {
  assert,
  assertEq,
  getHealthz,
  type HealthzBody,
  log,
  poll,
  runAllCleanups,
  runNode,
  sleep,
} from "../../harness/primitives.ts";
import { prepareArtifacts, type Layout, VERSION_A, VERSION_B } from "../../harness/artifacts.ts";
import { bootDaemon, readSentinel, stopDaemon } from "../../harness/daemon.ts";
import { listVersions, readJournal, readPointer, SEAM_MARKER } from "./observers.ts";
import { freshFixtureState, startFixture } from "./fixtureServer.ts";
import { installReleaseIntoSandbox } from "../../harness/installScript.ts";

// The ONLY env seam. Both URL overrides are documented CONFIG, not test seams: the web source is
// pointed at the fixture, and the git source at a closed loopback port — git is checked first and is
// baked to a real repository, so leaving it alone would put the network (and whatever that repo
// carries today) between this spec and its assertions. No trigger route, no NO_RELAUNCH, no PIN
// shrink: the press, the death and the return are all real.
function browserEnv(fixtureUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RU_CODE_UPDATE_WEB_URL: fixtureUrl,
    RU_CODE_UPDATE_GIT_URL: "http://127.0.0.1:59998/repo.git",
    RU_CODE_UPDATE_TEST_VERSION_FROM_DIR: "1",
  };
}

/**
 * Seed the app's OWN persisted config with `autoCheck: false` before boot — legitimate test setup
 * (the exact file the app writes; the dev harness seeds it identically), NOT a src seam. Kills the
 * hourly scheduler so every check in the spec is an explicit user click and the initial hero is a
 * truthful "never-checked".
 */
function seedAutoCheckOff(baseDir: string): void {
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "auto-update.json"),
    JSON.stringify(
      {
        configVersion: 3,
        autoCheck: false,
        jitterMinute: 30,
        sources: {
          git: {
            enabled: true,
            paused: false,
            authFails: 0,
            transportStreak: 0,
            failingSince: null,
            lastResult: null,
          },
          web: {
            enabled: true,
            paused: false,
            authFails: 0,
            transportStreak: 0,
            failingSince: null,
            lastResult: null,
          },
        },
        availableRelease: null,
        notified: { release: null, problems: null },
        notify: { releasesMuted: false, problemsMuted: false },
      },
      null,
      2,
    ),
  );
}

const origin = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** Wait until the PWA service worker is registered AND controlling this tab (poll in-page). */
async function waitForServiceWorkerControlling(page: Page): Promise<void> {
  // skipWaiting + clients.claim() (sw.ts) should hand control to the live tab without a reload; if
  // it has not within the budget, one reload deterministically enters the controlled state. Poll
  // BOTH signals in-page: an active registration AND a non-null controller.
  const deadline = Date.now() + 30_000;
  let reloadedOnce = false;
  for (;;) {
    const state = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { registered: false, controlling: false };
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        registered: reg?.active != null,
        controlling: navigator.serviceWorker.controller !== null,
      };
    });
    if (state.registered && state.controlling) return;
    if (state.registered && !state.controlling && !reloadedOnce) {
      reloadedOnce = true;
      await page.reload({ waitUntil: "load" });
    }
    if (Date.now() > deadline) {
      throw new Error(`service worker never became controlling (last: ${JSON.stringify(state)})`);
    }
    await sleep(300);
  }
}

/** Pair via the production tokenized URL (from the daemon's runtime-state file), then wait off /pair. */
async function pairViaRuntimeState(page: Page, baseDir: string): Promise<string> {
  const sentinel = readSentinel(baseDir);
  assert(sentinel !== null, "no runtime-state sentinel after boot");
  const pairingUrl = sentinel?.pairingUrl;
  assert(
    typeof pairingUrl === "string" && pairingUrl.length > 0,
    "runtime state carries no pairingUrl",
  );
  await page.goto(pairingUrl as string);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  return pairingUrl as string;
}

/** True when chromium is showing its own network-error interstitial (never allowed). */
async function chromeErrorShown(page: Page): Promise<boolean> {
  try {
    return (await page.locator("#main-frame-error").count()) > 0;
  } catch {
    return false;
  }
}

/**
 * Boot a REAL installed version-A tree with a paired, service-worker-controlled tab, and leave it on
 * the update settings page with a version B available. Everything here is setup — the assertions
 * that matter live in the specs.
 *
 * Used by the no-touch spec. The full-cycle spec below keeps its setup inline on purpose: its boot
 * runs INSIDE its own try so that a failure there still dumps the daemon and relaunch logs, and
 * trading that diagnostic for shared lines would be a bad bargain in the suite's pass-bar test.
 */
async function bootPairedAppOnSettingsWithReleaseAvailable(
  page: Page,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{
  readonly layout: Layout;
  readonly appPort: number;
  readonly fixture: Awaited<ReturnType<typeof startFixture>>;
}> {
  const prepared = prepareArtifacts({
    version: VERSION_B,
    withClient: true,
    seamMarker: SEAM_MARKER,
  });
  assert(prepared.clientDir !== null, "prepared artifacts must carry the real web client");
  const fixture = await startFixture(freshFixtureState(prepared));
  const layout: Layout = installReleaseIntoSandbox(prepared, VERSION_A).layout;
  seedAutoCheckOff(layout.baseDir);

  const bootA = await bootDaemon(layout, { ...browserEnv(fixture.url), ...extraEnv }, VERSION_A);
  const appPort = bootA.port;
  assertEq(readPointer(layout.appRoot)?.version, VERSION_A, "pointer at A before the cycle");
  await pairViaRuntimeState(page, layout.baseDir);
  await waitForServiceWorkerControlling(page);

  await page.goto(`${origin(appPort)}/settings/auto-update`);
  const hero = page.getByTestId("auto-update-hero");
  await expect(hero).toBeVisible();
  assertEq(
    await hero.getAttribute("data-version"),
    VERSION_A,
    "hero shows the installed version A",
  );

  // Same two real clicks as the main cycle: a fresh install has no working source yet, so the
  // per-source probe is what lights the hero's own «Проверить».
  const probeWeb = page.getByTestId("auto-update-probe-web");
  if ((await probeWeb.count()) > 0 && (await hero.getAttribute("data-phase")) === "never-checked") {
    await probeWeb.click();
    await expect
      .poll(() => hero.getAttribute("data-phase"), { timeout: 20_000, message: "probe answered" })
      .not.toBe("never-checked");
  }
  const checkNow = page.getByTestId("auto-update-check");
  await expect(checkNow).toBeEnabled({ timeout: 20_000 });
  await checkNow.click();
  await expect
    .poll(() => hero.getAttribute("data-phase"), { timeout: 30_000, message: "check → available" })
    .toBe("available");

  return { layout, appPort, fixture };
}

// ru-code: the two specs AU-04 was missing, and the reason a render-tree bug survived a green suite.
//
// The full cycle below deliberately RELOADS during the blind window to exercise the SW-served page,
// so its return is driven by that page's own poll and the in-app driver is never asked to do
// anything. Both specs here issue ZERO browser commands after the click, so the ONLY thing that can
// move the tab is `useAutoUpdateDriver` — which is exactly what was dead on `/settings/*` while the
// driver lived in the sidebar footer (a subtree the sidebar replaces with SettingsSidebarNav there).
//
// They differ in ONE input: how long the new server takes to bind its pinned port. That single knob
// puts the run on either side of UPDATE_INAPP_WAIT_MS and so selects which of the two designed
// paths runs — in-app return, or handover to the service worker.

/** Everything a no-touch observer can see about the tab, read without acting on it. */
interface TabView {
  readonly path: string;
  readonly swUpdating: boolean;
  readonly swDown: boolean;
  readonly heroVersion: string | null;
  readonly markerPresent: boolean;
}

async function readTab(page: Page): Promise<TabView> {
  return await page
    .evaluate(async (key) => {
      const markerPresent =
        typeof caches === "undefined"
          ? false
          : await caches
              .open("ru-code-sw-v1")
              .then(async (cache) => (await cache.match(key)) !== undefined)
              .catch(() => false);
      return {
        path: window.location.pathname,
        swUpdating: document.querySelector('[data-testid="sw-updating-page"]') !== null,
        swDown: document.querySelector('[data-testid="sw-down-page"]') !== null,
        heroVersion:
          document
            .querySelector('[data-testid="auto-update-hero"]')
            ?.getAttribute("data-version") ?? null,
        markerPresent,
      };
    }, "/__ru-code/update-marker")
    .catch(() => ({
      // A read that races a document swap is not a verdict — report "nothing seen" and sample again.
      path: "",
      swUpdating: false,
      swDown: false,
      heroVersion: null,
      markerPresent: false,
    }));
}

/**
 * Watch the tab WITHOUT touching it until it is back on version B, recording everything that
 * appeared on the way. `/healthz` is polled out of band over plain http — an observation of the
 * SERVER, not an action on the tab.
 */
async function observeUntilBackOnB(
  page: Page,
  appPort: number,
): Promise<{
  readonly everDown: boolean;
  readonly sawSwUpdating: boolean;
  readonly sawSwDown: boolean;
  readonly finalPath: string;
}> {
  let everDown = false;
  let sawSwUpdating = false;
  let sawSwDown = false;
  let finalPath = "";
  await poll(
    async () => {
      if ((await getHealthz(appPort)) === null) everDown = true;
      assert(
        !(await chromeErrorShown(page)),
        "chromium network-error page — the tab was left on a dead origin",
      );
      const view = await readTab(page);
      if (view.swUpdating) sawSwUpdating = true;
      if (view.swDown) sawSwDown = true;
      if (view.heroVersion === VERSION_B) {
        finalPath = view.path;
        return true;
      }
      return false;
    },
    {
      timeoutMs: 120_000,
      // Tight: the blind window can be sub-second, and "the SW page never appeared" is only worth
      // asserting if it could have been seen.
      intervalMs: 100,
      label: "the tab comes back on version B by itself (the test issues no navigation)",
    },
  );
  return { everDown, sawSwUpdating, sawSwDown, finalPath };
}

/** Poll until the driver has cleared the update marker — its exclusive job, and the AU-04 proof. */
async function waitForMarkerCleared(page: Page): Promise<void> {
  await poll(async () => !(await readTab(page)).markerPresent, {
    timeoutMs: 30_000,
    intervalMs: 250,
    label: "the driver clears the update marker",
  });
}

// CASE 1 — the restart fits inside UPDATE_INAPP_WAIT_MS.
//
// Nothing full-screen may happen: the in-app /healthz poll notices the new version and reloads the
// tab in place, so the user never leaves the page they pressed on. This is the case that was
// IMPOSSIBLE before `restartWaitArmed` — the drop handover reloaded the instant the socket died, so
// the 5-second budget never elapsed and every restart, however fast, became the SW takeover.
test("fast restart: the tab returns in place, on the same page, and never shows the SW page", async ({
  page,
}) => {
  test.slow();
  const { layout, appPort, fixture } = await bootPairedAppOnSettingsWithReleaseAvailable(page);

  try {
    await page.getByTestId("auto-update-install").click();
    const seen = await observeUntilBackOnB(page, appPort);

    assert(seen.everDown, "the old server was never observed down — no real blind window occurred");
    assert(
      !seen.sawSwUpdating && !seen.sawSwDown,
      `a service-worker page was shown for a restart inside the in-app budget (updating=${String(seen.sawSwUpdating)} down=${String(seen.sawSwDown)})`,
    );
    assertEq(seen.finalPath, "/settings/auto-update", "the tab stayed on the page it pressed from");
    await waitForMarkerCleared(page);

    const health = await getHealthz(appPort);
    assertEq(health?.version, VERSION_B, "healthz reports version B");
    assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer flipped to B");
    assertEq(readJournal(layout.appRoot)?.outcome, "ok", "journal outcome ok");
    log("[fast] returned in place on /settings/auto-update, no SW page, marker cleared");
  } finally {
    await fixture.close().catch(() => undefined);
    await runAllCleanups();
  }
});

// CASE 2 — the restart overruns UPDATE_INAPP_WAIT_MS.
//
// The outage is REAL and its LENGTH is the only thing the harness controls. `TEST_NO_RELAUNCH`
// stops the engine from spawning its own replacement, so the pointer flips, the run reaches
// `restart`, and the server is then stopped and brought back by this spec — through the very same
// `update-relaunch --port` entrypoint the engine would have used, on the very same pinned port.
// Nothing about the browser, the service worker, the marker or either decision is simulated: the
// tab is genuinely talking to a dead origin for longer than the in-app budget.
//
// (The first attempt at this used the shipped pinned-port retry seam to stall the bind. It never
// fired: the outgoing server releases the port 300 ms after spawning the child, which is sooner
// than the child gets around to probing it, so the retry path — the only thing that delay governs —
// is not on the happy path at all.)
//
// Expected: the in-app poll spends its budget, escalates, and the service worker takes the screen
// with the UPDATING page — never the down page, because a fresh marker is present. When the server
// is back, that page returns the tab to the update settings route.
test("slow restart: the SW updating page takes over and returns to the update page", async ({
  page,
}) => {
  test.slow();
  const { layout, appPort, fixture } = await bootPairedAppOnSettingsWithReleaseAvailable(page, {
    RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1",
  });
  const env = { ...browserEnv(fixture.url), RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1" };

  try {
    await page.getByTestId("auto-update-install").click();

    // The run got as far as the handover: pointer flipped, journal armed, nothing relaunched.
    await poll(() => Promise.resolve(readPointer(layout.appRoot)?.version === VERSION_B), {
      timeoutMs: 60_000,
      intervalMs: 200,
      label: "pointer flips to B (no relaunch)",
    });
    assertEq(readJournal(layout.appRoot)?.outcome, "started", "journal armed for the restart");

    // THE OUTAGE. From here the tab is on a dead origin, and only the app decides what it shows.
    await stopDaemon(layout, env);
    const downAt = Date.now();

    const swPage = await poll(
      async () => {
        assert(
          !(await chromeErrorShown(page)),
          "chromium network-error page — the tab was left on a dead origin",
        );
        const view = await readTab(page);
        if (view.swDown) return "down" as const;
        return view.swUpdating ? ("updating" as const) : false;
      },
      {
        timeoutMs: 45_000,
        intervalMs: 200,
        label: "the SW takes the screen once the in-app budget is spent",
      },
    );
    // A fresh marker means UPDATING. Serving the generic «приложение не отвечает» page here would
    // tell the user the app had crashed mid-update — the two must never be swapped.
    assertEq(swPage, "updating", "the SW served the DOWN page during an update");
    // Deliberately NOT asserted here: "the handover waited out UPDATE_INAPP_WAIT_MS". That budget
    // is measured from when the RESTART began (`run.restartedAtMs`), which in production is ~300 ms
    // before the server dies but in this spec is however long the pointer-flip poll above took — so
    // wall-clock from the outage is not the budget and asserting on it would only pin the harness's
    // own latency. CASE 1 is what proves the budget is honoured: there the SW page never appears at
    // all. This spec's job is the other half — that the escalation, once due, lands on the right
    // page and comes back to the right route.
    log(
      `[slow] SW updating page shown ${String(Date.now() - downAt)}ms after the server was stopped`,
    );

    // Bring the server back the way the engine would have: the real relaunch, the real pinned port.
    const relaunch = await runNode(
      [
        NodePath.join(layout.appRoot, "cli.js"),
        "update-relaunch",
        "--port",
        String(appPort),
        "--no-browser",
        "--base-dir",
        layout.baseDir,
      ],
      { env, timeoutMs: 60_000 },
    );
    assertEq(relaunch.code, 0, `update-relaunch failed: ${relaunch.stderr.slice(-400)}`);

    const seen = await observeUntilBackOnB(page, appPort);
    assertEq(
      seen.finalPath,
      "/settings/auto-update",
      "the SW updating page returned the tab to the update settings route",
    );
    await waitForMarkerCleared(page);

    const health = await getHealthz(appPort);
    assertEq(health?.version, VERSION_B, "healthz reports version B");
    assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer still B");
    log("[slow] returned to /settings/auto-update on version B, marker cleared");
  } finally {
    await fixture.close().catch(() => undefined);
    await runAllCleanups();
  }
});

test("full auto-update cycle on a real installed bundle: click → run → blind window → return v2.0.0", async ({
  page,
}) => {
  test.slow();

  // ── 1. build the real installed layout (version A, WITH the built web client) + boot ──────────
  const prepared = prepareArtifacts({
    version: VERSION_B,
    withClient: true,
    seamMarker: SEAM_MARKER,
  });
  assert(prepared.clientDir !== null, "prepared artifacts must carry the real web client");
  const fixture = await startFixture(freshFixtureState(prepared)); // serves manifest + tarball for B
  // The layout under the browser is produced by the REAL `install` script — the click-through runs
  // on a tree a user would actually have, not on one the harness assembled.
  const layout: Layout = installReleaseIntoSandbox(prepared, VERSION_A).layout;
  seedAutoCheckOff(layout.baseDir);
  const env = browserEnv(fixture.url);

  let dumpedOnFailure = false;
  const tailFile = (p: string, label: string): void => {
    try {
      if (NodeFS.existsSync(p) && NodeFS.statSync(p).isFile()) {
        log(`\n----- ${label} -----\n${NodeFS.readFileSync(p, "utf8").slice(-4000)}`);
      }
    } catch {
      /* best-effort diagnostics — never let the dumper throw over the real failure */
    }
  };
  const dumpDiagnostics = (): void => {
    if (dumpedOnFailure) return;
    dumpedOnFailure = true;
    tailFile(NodePath.join(layout.appRoot, "updates", "relaunch.log"), "updates/relaunch.log");
    for (const dir of [
      NodePath.join(layout.baseDir, "userdata"),
      NodePath.join(layout.baseDir, "userdata", "logs"),
    ]) {
      try {
        if (!NodeFS.existsSync(dir)) continue;
        for (const name of NodeFS.readdirSync(dir)) {
          if (name.endsWith(".log") || name.endsWith(".ndjson") || name.startsWith("daemon")) {
            tailFile(NodePath.join(dir, name), `${NodePath.basename(dir)}/${name}`);
          }
        }
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    const bootA = await bootDaemon(layout, env, VERSION_A);
    const appPort = bootA.port;
    assertEq(readPointer(layout.appRoot)?.version, VERSION_A, "pointer at A before the cycle");

    // ── 2. open the tokenized URL → app loads → wait for the SW to be registered + controlling ───
    await pairViaRuntimeState(page, layout.baseDir);
    log("[auth] fresh boot: paired via runtime-state pairingUrl (production path)");
    await waitForServiceWorkerControlling(page);
    log("[sw] service worker registered and controlling");

    // ── 3. update settings → hero → real first-check → available ──────────────────────────────
    await page.goto(`${origin(appPort)}/settings/auto-update`);
    const hero = page.getByTestId("auto-update-hero");
    await expect(hero).toBeVisible();
    const initialPhase = await hero.getAttribute("data-phase");
    assertEq(
      await hero.getAttribute("data-version"),
      VERSION_A,
      "hero shows the installed version A",
    );
    log(`[hero] initial data-phase=${String(initialPhase)}`);

    // The hero "Check now" is gated on a WORKING (previously-probed) source, so on a truly fresh
    // install the real first-check control is the per-source «Проверить» (auto-update-probe-web) —
    // both are real WS RPCs. Probe → up-to-date lights the hero button; then click it → available.
    const probeWeb = page.getByTestId("auto-update-probe-web");
    if (
      (await probeWeb.count()) > 0 &&
      (await hero.getAttribute("data-phase")) === "never-checked"
    ) {
      await probeWeb.click();
      await expect
        .poll(() => hero.getAttribute("data-phase"), {
          timeout: 20_000,
          message: "probe → up-to-date",
        })
        .not.toBe("never-checked");
      log(`[hero] after web probe: data-phase=${String(await hero.getAttribute("data-phase"))}`);
    }

    const checkNow = page.getByTestId("auto-update-check");
    await expect(checkNow).toBeEnabled({ timeout: 20_000 });
    await checkNow.click();
    await expect
      .poll(() => hero.getAttribute("data-phase"), {
        timeout: 30_000,
        message: "check → available",
      })
      .toBe("available");
    log("[hero] data-phase=available");

    // ── 4 + 5 + 6. click Install → run → BLIND WINDOW → RETURN — ONE fast bounded loop (≤120s) ─────
    // The real WS install RPC fires on click. There is NO navigation any more (F13): the hero card
    // itself becomes the run view, so the WS stays alive and the server-owned run is never
    // interrupted. When the server finally dies, the app's own driver reloads the tab and the
    // service worker serves the full-screen update page. We poll /healthz from the instant of the
    // click at a tight interval so the sub-second blind window is never missed, while sampling the
    // hero's inline run block.
    const settingsUrlDuringRun = page.url();
    const runPhase = page.locator('[data-testid="auto-update-run"]');
    await page.getByTestId("auto-update-install").click();

    const phasesSeen = new Set<string>();
    let everDown = false;
    let sawUpdatingWhileDown = false;
    let swPageHit = false;
    let swReloadTried = false;
    let pressStayedOnSettings = true;
    let healthB: HealthzBody | null = null;

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const health = await getHealthz(appPort);
      if (health === null) everDown = true;
      // While the server is still alive the tab must still be the settings page: the press starts a
      // run, it does not navigate. (Once the server dies the driver reloads into the SW page.)
      if (health !== null && !everDown && page.url() !== settingsUrlDuringRun) {
        pressStayedOnSettings = false;
      }
      if (health !== null && health.version === VERSION_B && health.lastApply?.outcome === "ok") {
        healthB = health;
        break;
      }

      // A chromium network-error interstitial is NEVER acceptable — the tab must always be OUR UI.
      assert(
        !(await chromeErrorShown(page)),
        "chromium network-error page shown during the blind window",
      );

      // Collect live run phases + detect updating-state UI (the inline hero run OR the SW page).
      const swUpdating = await page
        .locator('[data-testid="sw-updating-page"]')
        .count()
        .catch(() => 0);
      let inAppRun = 0;
      for (const el of await runPhase.all().catch(() => [])) {
        inAppRun += 1;
        const p = await el.getAttribute("data-phase").catch(() => null);
        if (p !== null) phasesSeen.add(p);
      }
      if (swUpdating > 0) swPageHit = true;
      if ((swUpdating > 0 || inAppRun > 0) && health === null) sawUpdatingWhileDown = true;

      // Once — while the server is genuinely down — force a navigation to exercise the REAL SW page.
      if (health === null && !swReloadTried) {
        swReloadTried = true;
        try {
          await page.reload({ waitUntil: "commit", timeout: 6_000 });
          if (
            (await page
              .locator('[data-testid="sw-updating-page"]')
              .count()
              .catch(() => 0)) > 0
          ) {
            swPageHit = true;
            log(
              "[blind] deliberate reload while down → SW-served updating page (data-testid=sw-updating-page)",
            );
          }
          assert(
            !(await chromeErrorShown(page)),
            "reload while down produced a chromium error page",
          );
        } catch {
          // A reload racing the server's return can abort — tolerated; the in-app evidence stands.
        }
      }

      await sleep(150);
    }

    log(`[updating] live run phases observed inline on the hero: [${[...phasesSeen].join(",")}]`);
    assert(phasesSeen.size > 0, "no live run phase was ever observed on the settings hero");
    assert(everDown, "the old server was never observed down — no real blind window occurred");
    assert(
      pressStayedOnSettings,
      "the press navigated away from the settings page — the hero must own the run (F13)",
    );
    assert(
      sawUpdatingWhileDown,
      "no updating-state UI (in-app OR SW) was shown while the server was down",
    );
    assert(healthB !== null, "server never returned on version B with lastApply ok within 120s");
    log(
      `[blind] everDown=${String(everDown)} sawUpdatingWhileDown=${String(sawUpdatingWhileDown)} ` +
        `swPageHit=${String(swPageHit)} runPhasesSeen=[${[...phasesSeen].join(",")}]`,
    );
    log(
      `[return] /healthz → version ${healthB?.version}, lastApply ${healthB?.lastApply?.outcome}, pid ${String(healthB?.pid)}`,
    );

    // ── 6. RETURN assertions: the app is back, functional, on B; on-disk truth is consistent ─────
    assertEq(healthB?.version, VERSION_B, "healthz reports version B");
    assertEq(healthB?.lastApply?.outcome, "ok", "healthz lastApply ok");
    assertEq(healthB?.lastApply?.targetVersion, VERSION_B, "healthz lastApply target B");

    // The page auto-reloads itself on return (in-app poller / SW countdown). Settle onto the live
    // app, then land on the settings hero. FIRST test whether the session survived (same baseDir,
    // signing key + session store both file/sqlite-persisted): navigate the authenticated route
    // ONCE and let the app reconnect its WS subscription. CRUCIAL: do NOT re-navigate while waiting
    // — every goto resets the connection, so repeated gotos would thrash the subscription and the
    // hero (which renders null until useAutoUpdate() gets its first snapshot) would never appear.
    const settingsUrl = `${origin(appPort)}/settings/auto-update`;
    // POLL for the tab to settle, never sleep for it. The app returns by itself here (the in-app
    // /healthz poller or the SW page's countdown fires a reload), and a fixed 1.5 s was a guess at
    // how long that takes on the slowest machine that will ever run this — in the most
    // timing-sensitive moment of the suite whose own law is "there are NO bare sleeps: a sleep is
    // a guess, a poll is a fact". The FACT is that the document stops being replaced: once two
    // consecutive polls see the same live document, the auto-reload has happened.
    let settledDocuments = 0;
    await poll(
      async () => {
        const alive = await page
          .evaluate(() => document.readyState === "complete")
          .catch(() => false);
        settledDocuments = alive ? settledDocuments + 1 : 0;
        return settledDocuments >= 2;
      },
      { timeoutMs: 30_000, intervalMs: 250, label: "tab settles after the auto-reload" },
    );
    const cookiesAfterReturn = (await page.context().cookies()).map((c) => c.name);
    log(`[return] tab settled at ${page.url()} after auto-reload`);

    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const landed = await poll(
      async () => {
        assert(!(await chromeErrorShown(page)), "chromium error page after return");
        const path = new URL(page.url()).pathname;
        if (path.startsWith("/pair")) return "pair" as const; // session rejected → needs re-pair
        if ((await page.getByTestId("auto-update-hero").count()) > 0) return "hero" as const;
        return false; // still reconnecting the subscription — keep waiting WITHOUT re-navigating
      },
      { timeoutMs: 40_000, intervalMs: 500, label: "post-return route settles (hero or /pair)" },
    );
    log(`[return] post-return route settled as: ${landed}`);

    let cookieSurvived = landed === "hero";
    if (!cookieSurvived) {
      // The tab was redirected to /pair — the session did not survive. Re-pair via the RELAUNCHED
      // daemon's FRESH runtime-state token (the production mechanism — a real user reopens the new
      // tokenized URL the restarted daemon persists), then land on settings once and let it connect.
      await pairViaRuntimeState(page, layout.baseDir);
      await page.goto(settingsUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    log(
      `[auth] after restart: session cookie ${cookieSurvived ? "SURVIVED (no re-pair needed)" : "did NOT survive → re-paired via the relaunched daemon's fresh runtime-state token"}` +
        ` — context cookies after return: [${cookiesAfterReturn.join(",") || "none"}]`,
    );
    // ASSERTED, not merely logged. Both branches used to continue to the same checks, so a
    // regression that logged every user out on every update produced an identical green run — on
    // the one suite that performs a real update. Survival is a DESIGN property here: the signing
    // key and the session store are both persisted under the same `baseDir` the relaunched daemon
    // reuses, so an update that costs the user their session is a defect, not an environment.
    assert(
      cookieSurvived,
      "the session did not survive the update — the tab was bounced to /pair (signing key or session store not persisted across the relaunch)",
    );

    const heroBack = page.getByTestId("auto-update-hero");
    await expect(heroBack).toBeVisible({ timeout: 30_000 });
    assertEq(await heroBack.getAttribute("data-version"), VERSION_B, "hero now shows version B");
    assert(
      (await heroBack.getAttribute("data-phase")) !== "available",
      "hero is not still advertising an available update after applying it",
    );
    log(
      `[hero] back on version B — data-phase=${String(await heroBack.getAttribute("data-phase"))}, data-version=${String(await heroBack.getAttribute("data-version"))}`,
    );

    // on-disk truth: pointer flipped, journal ok, GC left exactly versions/B.
    assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer flipped to B");
    assertEq(readJournal(layout.appRoot)?.outcome, "ok", "journal outcome ok");
    assertEq(readJournal(layout.appRoot)?.targetVersion, VERSION_B, "journal target B");
    const versions = listVersions(layout.appRoot);
    assertEq(versions.join(","), VERSION_B, "GC left exactly versions/B");
    assert(
      fixture.state.requests.some((r) => r.startsWith(`/${releaseTarballName(VERSION_B)}`)),
      "the real tarball was downloaded from the fixture",
    );
    log(`[disk] pointer=B, journal=ok, GC=[${versions.join(",")}], tarball downloaded ✓`);
  } catch (error) {
    dumpDiagnostics();
    throw error;
  } finally {
    // 7. teardown ALWAYS: shared cleanups stop the daemon child (pid from runtime state) + SIGKILL,
    //    close the fixture server, and rm every sandbox temp dir (never touches the real ~/.ru-code).
    await fixture.close().catch(() => undefined);
    await runAllCleanups();
  }
});
