// ru-code (plugin system, A10): the PLUGINS suite.
//
// Same real built app and same fake ACP as every other suite, but with THREE plugin folders dropped
// into `<baseDir>/plugins/` before the server starts: the real `demo` (the `dist/` of
// `@smart-tools/plugin-demo`, i.e. the artifact a user copies), the `demo-broken` fixture that
// throws in its server `activate`, and a generated `hang` whose web `activate` never settles.
//
// A separate config rather than a flag on the main one — the pixso suite's doctrine, and here it is
// load-bearing three times over:
//
//  · these specs need the untracked `ru-code-packages` symlink and a built demo package, which the
//    default gate suite must never depend on;
//  · the plugins directory has to be seeded BEFORE the spawn (`PluginHost.start` scans once per
//    process), and the shared `scripts/bootApp.ts` has no hook for that;
//  · the boot deliberately does NOT build (mvp-plan D9: build, then run `dist`), whereas the shared
//    globalSetup rebuilds the app on every run.
//
// Screenshots: `harness/pluginsEvidence.ts` writes every named shot into
// `.artifacts-plugins/screenshots/` and mirrors it into `RU_CODE_E2E_EVIDENCE_DIR` — which defaults
// to `WORKFLOW/evidence/e2e`. Set the variable to another path to collect a run elsewhere, or to ""
// to skip the mirror entirely.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-plugins",
  testMatch: /.*\.e2e\.test\.ts/,
  // ONE app for the whole suite, ONE worker, in file order. Two of the specs are stateful against
  // the shared app on purpose — `localeTheme` switches the app's language (which reloads the page)
  // and `uninstall` stops the server, deletes a folder and restarts it — so parallelism is not a
  // speed trade-off here, it is a correctness one. `uninstall.e2e.test.ts` sorts last of the seven
  // file names, which is why the restart it performs cannot disturb anything.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The isolation spec waits out the web loader's 10 s per-plugin budget and then some, and the
  // attach spec drives a real send through the fake CLI; 60 s left no headroom over the per-expect
  // timeouts those legitimately use.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./.artifacts-plugins/test-results",
  globalSetup: "./harness/pluginsBoot.ts",
  globalTeardown: "./harness/pluginsTeardown.ts",
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Written by globalSetup — the loopback auto-auth snapshot, including the IndexedDB
    // environment registration every env RPC needs.
    storageState: "./.artifacts-plugins/auth.json",
  },
});
