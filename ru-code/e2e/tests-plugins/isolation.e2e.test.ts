// ru-code (A10) — spec 6: a broken plugin and a hanging plugin disable only THEMSELVES.
//
// mvp-plan guardrail 8, as a browser fact. Three plugins are in the folder for the whole suite and
// this spec is the one that watches all three at once, from the very first navigation:
//
//  · `demo-broken` throws in its SERVER `activate`. Until A9-fix that was completely silent in the
//    UI (A9 finding MEDIUM-1) — the row said `failed` in `manifests.json` and nothing else happened.
//    Now the web loader toasts it EXACTLY ONCE with the server's own reason, and the console gets
//    one `[plugins] demo-broken: …` line;
//  · `demo-hang`'s web `activate` never settles. The app must be interactive long before its 10 s
//    budget expires, and when the budget does expire the plugin is reported timed out — once;
//  · `demo` is unaffected throughout: its icon is up in the first second and a note round-trips
//    while both siblings are dead.
//
// HOW THE TOASTS ARE OBSERVED. They land ~10 s apart (one at import time, one when the budget
// expires) and each is on screen for only a few seconds, so no amount of polling `document` at
// convenient moments is reliable — an earlier draft of this spec did exactly that and missed the
// first one every run. Instead a `MutationObserver` is installed BEFORE any app code runs and
// records every node whose text reads like a plugin failure, with the time it appeared. The
// assertions then read a complete log rather than whatever happened to be on screen, and the
// screenshot loop only has to catch each toast for the picture. Since A13 closed A10's P1 both
// toasts land, and both are asserted.
// @effect-diagnostics globalTimers:off
import {
  addDemoNote,
  clearDemoNotes,
  closeDemoPanel,
  DEMO_BROKEN_ID,
  DEMO_HANG_ID,
  demoNoteBodies,
  expect,
  openDemoPanel,
  state,
  test,
} from "./fixtures.ts";
import { PLUGIN_LOAD_TIMEOUT_MS } from "../harness/pluginsBoot.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

interface ToastRecord {
  readonly atMs: number;
  readonly text: string;
}

declare global {
  interface Window {
    __pluginFailureToasts?: ToastRecord[];
  }
}

const FAILURE_PATTERN = /не загрузился|failed to load|PluginLoadTimeout|timed out after|boom/i;

test.describe("plugins — a throwing and a hanging sibling are isolated", () => {
  test("both failures are reported once each, the app never waits for them, and the demo keeps working", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Pre-existing and unrelated: a thread route probe 404s during boot in every suite.
      if (
        text.includes("the server responded with a status of 404") &&
        message.location().url.includes("/api/orchestration/threads/")
      ) {
        return;
      }
      consoleErrors.push(text);
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // Installed before any app script: nothing that appears can be missed.
    await page.addInitScript(() => {
      const log: Array<{ atMs: number; text: string }> = [];
      window.__pluginFailureToasts = log;
      const pattern = /не загрузился|failed to load|PluginLoadTimeout|timed out after|boom/i;
      // RESCAN the toast surfaces rather than reading the added node: a toast portal is mounted
      // EMPTY and filled a tick later, so an observer that only reads `addedNodes[i].textContent`
      // sees "" for the first toast of a page and silently misses it. Deduplicated by text, with
      // a 100 ms tick as a belt-and-braces fallback for anything a mutation batch coalesces away.
      const scan = (): void => {
        const nodes = document.querySelectorAll(
          '[data-slot="toast-root"], [data-slot="toast-title"], [data-slot="toast-description"], [role="status"], [role="alert"]',
        );
        for (const node of nodes) {
          const text = (node.textContent ?? "").trim();
          if (text.length === 0 || text.length > 400 || !pattern.test(text)) continue;
          if (log.some((entry) => entry.text === text)) continue;
          log.push({ atMs: Math.round(performance.now()), text });
        }
      };
      new MutationObserver(scan).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      setInterval(scan, 100);
    });

    const startedAt = Date.now();
    await page.goto(state().webUrl, { waitUntil: "domcontentloaded" });

    // ── one loop: timings + the toast pictures, from the first frame ───────────────────────────
    const settings = page.getByRole("button", { name: /^(Настройки|Settings)$/ });
    const demoIcon = page.getByRole("button", { name: /^(Демо|Demo)$/ });
    let appReadyMs: number | null = null;
    let demoIconMs: number | null = null;
    let hangShot = false;
    const deadline = startedAt + PLUGIN_LOAD_TIMEOUT_MS + 8_000;
    while (Date.now() < deadline) {
      if (appReadyMs === null && (await settings.count()) > 0) appReadyMs = Date.now() - startedAt;
      if (demoIconMs === null && (await demoIcon.count()) > 0) demoIconMs = Date.now() - startedAt;
      const toasts = await page
        .evaluate(() => window.__pluginFailureToasts ?? [])
        .catch(() => [] as ToastRecord[]);
      if (!hangShot && toasts.some((entry) => /hang|timed out/i.test(entry.text))) {
        // Let the toast finish sliding in — caught at first sight it is half off the right edge.
        await page.waitForTimeout(600);
        await saveEvidenceScreenshot(page, "06-hang-toast");
        hangShot = true;
      }
      if (appReadyMs === null || demoIconMs === null) await page.waitForTimeout(100);
      else await page.waitForTimeout(200);
    }

    expect(appReadyMs, "the app renders with two broken plugins in the folder").not.toBeNull();
    expect(demoIconMs, "the healthy plugin's icon appears").not.toBeNull();
    // The healthy plugin is up long before the hanging one's budget could have expired.
    expect(
      demoIconMs ?? Number.POSITIVE_INFINITY,
      "the hanging plugin must not delay the healthy one (or the app)",
    ).toBeLessThan(PLUGIN_LOAD_TIMEOUT_MS);

    const toasts = await page.evaluate(() => window.__pluginFailureToasts ?? []);
    const seen = toasts.map((entry) => entry.text);
    expect(seen.every((text) => FAILURE_PATTERN.test(text))).toBe(true);

    // The plugin that never settled is TOASTED, once: its failure is reported ~10 s in, long after
    // the toast viewport exists.
    expect(
      seen.some((text) => /timed out after|PluginLoadTimeout/i.test(text)),
      `the plugin whose web activate() never settles is toasted; saw ${JSON.stringify(seen)}`,
    ).toBe(true);
    expect(
      seen.filter((text) => /Demo \(hang\)/.test(text)),
      "exactly one toast for the hanging plugin",
    ).toHaveLength(1);

    // A13 — A10 finding P1, now FIXED and therefore asserted rather than recorded.
    //
    // The plugin whose SERVER half throws is reported by `loadPlugins()` within milliseconds of
    // `createRoot(...).render(...)`. `flushPluginProblems()` used to set `viewportReady = true`
    // itself at that moment — but `render()` is asynchronous, base-ui's `<Toast.Provider>` had not
    // subscribed yet, and `toastManager.add()` with an empty listener set simply drops the message.
    // Measured then, three runs, zero toasts. The flag now belongs to the TOASTER
    // (`markPluginToastViewportReady()` from `ToastProvider`'s mount effect), so an early failure
    // queues and lands as soon as there is somewhere for it to land.
    const brokenToastRendered = seen.some((text) => /Demo \(broken\)|boom/.test(text));
    expect(
      brokenToastRendered,
      `the SERVER-side failure is toasted too, not only logged; saw ${JSON.stringify(seen)}`,
    ).toBe(true);
    expect(
      seen.filter((text) => /Demo \(broken\)/.test(text)),
      "exactly one toast for the throwing plugin",
    ).toHaveLength(1);

    // ── exactly one console line per failure, and nothing for the healthy plugin ───────────────
    const brokenLines = consoleErrors.filter((text) => text.includes(DEMO_BROKEN_ID));
    const hangLines = consoleErrors.filter((text) => text.includes(DEMO_HANG_ID));
    const demoLines = consoleErrors.filter((text) => /\[plugins\] demo:/.test(text));
    expect(brokenLines, "one console error for the throwing plugin").toHaveLength(1);
    expect(hangLines, "one console error for the hanging plugin").toHaveLength(1);
    expect(demoLines, "and none for the healthy one").toHaveLength(0);
    // The brief's budget: at most one console error that is NOT one of those two.
    const otherErrors = consoleErrors.filter(
      (text) => !text.includes(DEMO_BROKEN_ID) && !text.includes(DEMO_HANG_ID),
    );
    expect(
      otherErrors.length,
      `at most one unrelated console error; got ${JSON.stringify(otherErrors)}`,
    ).toBeLessThanOrEqual(1);
    // A plugin failure must never become a failure of the HOST.
    expect(pageErrors, "no uncaught page error").toEqual([]);

    // Neither failed plugin contributed any UI.
    expect(
      await page.getByRole("button", { name: /Demo \(broken\)|Demo \(hang\)/ }).count(),
      "a failed plugin registers no footer icon",
    ).toBe(0);
    await saveEvidenceScreenshot(page, "06-boot-with-broken-and-hang");

    // ── the demo works while both siblings are dead ────────────────────────────────────────────
    await openDemoPanel(page);
    await clearDemoNotes(page);
    await addDemoNote(page, "note beside a broken plugin");
    expect(await demoNoteBodies(page)).toEqual(["note beside a broken plugin"]);
    await saveEvidenceScreenshot(page, "06-demo-works-beside-broken");
    await clearDemoNotes(page);
    await closeDemoPanel(page);

    saveEvidenceJson("06-isolation", {
      spec: "isolation.e2e.test.ts",
      appReadyMs,
      demoIconAttachedMs: demoIconMs,
      pluginLoadTimeoutMs: PLUGIN_LOAD_TIMEOUT_MS,
      failureToasts: toasts,
      brokenToastRendered,
      brokenConsoleErrors: brokenLines,
      hangConsoleErrors: hangLines,
      demoConsoleErrors: demoLines,
      otherConsoleErrors: otherErrors,
      pageErrors,
    });
  });
});
