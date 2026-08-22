// ru-code: THE real-browser auto-update acceptance config (E2E-C, to-do.md §8.3 [L]).
//
// Self-contained — deliberately NOT the dev-harness config (../../playwright.config.ts): this
// suite boots its OWN real installed bundle inside the single spec, so there is no globalSetup and
// no shared harness state. One chromium project, serial, generous timeout (the spec builds a real
// layout, boots the daemon chain, drives the full download→verify→flip→restart→return cycle in a
// real tab).
//
// retries: 0 — the same rule as the dev-harness config, and for the same reason: determinism beats
// speed here. A retry does not make a suite reliable, it makes an unreliable one LOOK reliable —
// and this is the one suite that performs a real update, so a nondeterminism it hides is a
// nondeterminism in the update itself. Every wait in the spec is a bounded poll on an observable
// fact (the last bare sleep is gone), so a failure now means something is actually wrong. The
// trace is captured on the first failure instead of on a retry.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /browserCycle\.e2e\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The whole real cycle (artifact assembly with the built client + boot + pair + check + install +
  // blind window + return) runs inside one test — give it room; bounded polls guard every wait.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    video: "off",
  },
});
