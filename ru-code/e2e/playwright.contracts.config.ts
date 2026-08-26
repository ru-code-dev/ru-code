// ru-code: CONTRACTS suite config — cross-cutting invariants (auth/time, spawn-env) asserted
// against a real installed app. No globalSetup: like tests-performance, every case boots (and
// stops) its own daemonised app via the shared pin harness (harness/pinHarness.ts) — that self-boot
// is exactly why these cannot share a worker with tests-core's single shared-app globalSetup (a
// pin's boot forces a fresh production rebuild of apps/server/dist mid-run, which was corrupting
// every other tests-core spec sharing that process). Settings/timeouts mirror
// playwright.performance.config.ts where sensible.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-contracts",
  testMatch: /.*\.e2e\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: ".artifacts-contracts/results.json" }]],
  outputDir: ".artifacts-contracts/test-output",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
