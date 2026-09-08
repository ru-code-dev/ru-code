// ru-code (A10) — spec 1: `/plugins/manifests.json` and the asset route's refusals.
//
// This is the plugin system's ONLY server-side contract with the browser, and the one diagnostic an
// author has when a folder does not show up. Everything the web loader decides is decided from these
// rows, so they are asserted field by field rather than "looks about right":
//
//  · `demo`        loaded, both halves, and the exact `web` / `styles` paths the loader joins onto
//                  `/plugins/demo/`;
//  · `demo-broken` failed with the server's own reason — AND advertising no web entry, because
//                  `resolvePluginDir` serves `loaded` plugins only and the route would 404 it
//                  (A9 finding LOW-3, fixed in A9-fix);
//  · `hang`        loaded server-side with `hasServer: false` — its web half is what never settles,
//                  which the server has no way to know and must not pretend to.
//
// Then the two refusals that make the route safe: `server/**` is never served (it is the plugin's
// server code), and a traversal out of the plugin folder is never a 200.
import {
  COMPOSER,
  DEMO_BROKEN_ID,
  DEMO_HANG_ID,
  DEMO_ID,
  expect,
  fetchManifests,
  openAppWithDemo,
  rawStatusOf,
  state,
  statusOf,
  test,
  type PluginManifestRow,
} from "./fixtures.ts";
import { saveEvidenceJson, saveEvidenceScreenshot } from "../harness/pluginsEvidence.ts";

const rowFor = (
  rows: ReadonlyArray<PluginManifestRow>,
  id: string,
): PluginManifestRow | undefined => rows.find((row) => row.id === id);

test.describe("plugins — manifests.json and the asset route", () => {
  test("reports the three seeded plugins with the right state, and refuses server/** and traversal", async ({
    page,
  }) => {
    const rows = await fetchManifests();

    const demo = rowFor(rows, DEMO_ID);
    expect(demo, "the demo plugin is in manifests.json").toBeDefined();
    expect(demo).toMatchObject({
      id: DEMO_ID,
      name: "Demo",
      version: "0.1.0",
      state: "loaded",
      hasWeb: true,
      hasServer: true,
      web: "web/index.mjs",
      styles: "web/styles.css",
    });

    const broken = rowFor(rows, DEMO_BROKEN_ID);
    expect(broken, "the throwing fixture is in manifests.json").toBeDefined();
    expect(broken?.state).toBe("failed");
    expect(broken?.hasServer).toBe(true);
    // The server's own message, verbatim — this is what the web loader shows in its toast.
    expect(broken?.error).toContain("boom");
    // A9 LOW-3 / A9-fix: a failed plugin's files 404, so it must not advertise any.
    expect(broken?.hasWeb).toBe(false);
    expect(broken?.web).toBeUndefined();

    const hang = rowFor(rows, DEMO_HANG_ID);
    expect(hang, "the hanging fixture is in manifests.json").toBeDefined();
    expect(hang?.state).toBe("loaded");
    expect(hang?.hasServer).toBe(false);
    expect(hang?.hasWeb).toBe(true);

    // ── the servable surface ──────────────────────────────────────────────────────────────────
    expect(await statusOf(`/plugins/${DEMO_ID}/web/index.mjs`), "the web entry is served").toBe(
      200,
    );
    expect(await statusOf(`/plugins/${DEMO_ID}/web/styles.css`), "the stylesheet is served").toBe(
      200,
    );
    // The plugin's SERVER code must never reach a browser.
    expect(await statusOf(`/plugins/${DEMO_ID}/server/index.mjs`), "server/** is refused").toBe(
      404,
    );
    // Nor the raw manifest — `manifests.json` is the filtered view.
    expect(await statusOf(`/plugins/${DEMO_ID}/plugin.json`), "plugin.json is refused").toBe(404);
    // A failed plugin resolves to no directory at all.
    expect(
      await statusOf(`/plugins/${DEMO_BROKEN_ID}/web/index.mjs`),
      "a failed plugin's files 404",
    ).toBe(404);

    // ── traversal ─────────────────────────────────────────────────────────────────────────────
    // `rawStatusOf`, not `statusOf`: a `URL` collapses `..` before the request is built, so `fetch`
    // would ask for `/etc/passwd` and measure the SPA fallback rather than this route.
    for (const path of [
      `/plugins/${DEMO_ID}/web/../../../etc/passwd`,
      `/plugins/${DEMO_ID}/web/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      `/plugins/${DEMO_ID}/web/../server/index.mjs`,
      `/plugins/${DEMO_ID}/web/..%2f..%2fserver%2findex.mjs`,
    ]) {
      const status = await rawStatusOf(path);
      expect(status, `${path} must not be 200`).not.toBe(200);
    }

    saveEvidenceJson("01-manifests", {
      spec: "manifests.e2e.test.ts",
      manifests: rows,
      routes: {
        webEntry: await statusOf(`/plugins/${DEMO_ID}/web/index.mjs`),
        styles: await statusOf(`/plugins/${DEMO_ID}/web/styles.css`),
        serverEntry: await statusOf(`/plugins/${DEMO_ID}/server/index.mjs`),
        rawManifest: await statusOf(`/plugins/${DEMO_ID}/plugin.json`),
        brokenWebEntry: await statusOf(`/plugins/${DEMO_BROKEN_ID}/web/index.mjs`),
        traversalLiteral: await rawStatusOf(`/plugins/${DEMO_ID}/web/../../../etc/passwd`),
        traversalEncoded: await rawStatusOf(
          `/plugins/${DEMO_ID}/web/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
        ),
        traversalToServerHalf: await rawStatusOf(`/plugins/${DEMO_ID}/web/../server/index.mjs`),
      },
    });

    // The two pictures that go with it: the app up with the plugin loaded, and the raw route the
    // whole web loader reads — the one place an author can see WHY a folder did not come up.
    await openAppWithDemo(page);
    // Wait for the app to be USABLE before the shot — a picture of a half-mounted shell proves
    // nothing about the plugin having loaded into it.
    await expect(page.locator(COMPOSER).first()).toBeVisible({ timeout: 60_000 });
    await saveEvidenceScreenshot(page, "01-manifests-app-booted");
    await page.goto(`${state().webUrl}/plugins/manifests.json`, { waitUntil: "domcontentloaded" });
    await saveEvidenceScreenshot(page, "01-manifests-json", { fullPage: true });
  });
});
