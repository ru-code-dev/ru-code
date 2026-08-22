// ru-code: PIN suite config — fault-injection boots of the real installed app.
// No globalSetup: every pin boots (and stops) its own daemonised app inside the spec, because the
// faults are per-boot (env knobs, CPU pinning, frozen pids). Serial on purpose: pins measure the
// machine, so they must not share it with each other.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-pins",
  testMatch: /.*\.pins\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: ".artifacts-pins/results.json" }]],
  outputDir: ".artifacts-pins/test-output",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
