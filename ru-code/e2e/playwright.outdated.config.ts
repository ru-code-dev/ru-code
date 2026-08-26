// ru-code: OUTDATED suite config — quarantined pins (see tests-outdated/README.md).
// Mirrors playwright.performance.config.ts's settings/timeouts: same no-globalSetup shape (each spec
// boots/stops its own daemonised app), same serial-only posture. Every test here carries a
// leading `test.skip(...)`, so this suite always reports SKIPPED and exits 0 — it exists so the
// quarantined cases stay listable/runnable on their own without polluting tests-performance's results.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-outdated",
  testMatch: /.*\.pins\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: ".artifacts-outdated/results.json" }]],
  outputDir: ".artifacts-outdated/test-output",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
