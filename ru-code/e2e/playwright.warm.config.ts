// ru-code (agentic-flow wave, live-issues T1): the WARM-POOL suite.
//
// Same real app, same fake ACP, same globalSetup — one difference: the ACP
// warm pool is ON. That is not a detail, it is the whole point. The owner's
// report is about what happens AFTER a Stop: the bound child is killed and the
// next send rides a session the POOL hands over, so the thread's session
// identity CHANGES underneath the UI. With the pool off (the default suite's
// substrate, bootApp.ts) that handoff never happens and the path cannot be
// tested at all.
//
// A separate config rather than a flag on the main one: the default suite keeps
// its substrate byte-for-byte, and these specs cannot perturb it.
process.env["RU_CODE_E2E_WARM_ENGINE"] = "1";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-warm",
  testMatch: /.*\.warm\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Generous: these cases must be able to WAIT long enough to tell a
  // seconds-late indicator from one that never comes back.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./scripts/bootApp.ts",
  globalTeardown: "./scripts/stopApp.ts",
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    storageState: "./.artifacts/auth.json",
  },
});
