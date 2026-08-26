// ru-code (branch-sync v5, F4): the PIXSO suite.
//
// Same real app, same fake ACP, same globalSetup — but with the fake Pixso desktop
// MCP spawned too (gated on RU_CODE_E2E_PIXSO, set below). These specs need the
// untracked `ru-code-packages` symlink, a real capture corpus and port 3667, and
// several run 180-360 s — heavy enough that they must not sit in the default gate
// suite's shared app boot.
//
// A separate config rather than a flag on the main one: the default suite keeps
// its substrate byte-for-byte, and these specs cannot perturb it (playwright.warm.config.ts's
// own doctrine).
process.env["RU_CODE_E2E_PIXSO"] = "1";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-pixso",
  testMatch: /.*\.e2e\.test\.ts/,
  // Scroll physics are timing-sensitive: one worker, no parallelism, generous
  // timeouts — determinism beats speed here.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A case must die on its own ASSERTION message, never on the case budget: the pixso
  // cases chain a panel boot, three ~1 s scans, a settle wait and a full reload, and 60 s
  // left no headroom over the per-expect timeouts they legitimately use.
  timeout: 120_000,
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
