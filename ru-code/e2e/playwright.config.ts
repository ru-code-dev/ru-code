// ru-code: real-Chrome harness config. The app (server + web) is booted ONCE by
// globalSetup (scripts/bootApp.ts) with the fake ACP as the CLI and an isolated
// HOME/T3CODE_HOME; its resolved web URL lands in harness-state.json, which the
// specs read via fixtures.ts. Chromium 1217 is already installed on this machine
// (playwright 1.60) — no downloads.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.e2e\.test\.ts/,
  // Scroll physics are timing-sensitive: one worker, no parallelism, generous
  // timeouts — determinism beats speed here.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./scripts/bootApp.ts",
  globalTeardown: "./scripts/stopApp.ts",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Written by globalSetup after pairing with the runner's one-time token.
    storageState: "./.artifacts/auth.json",
  },
});
