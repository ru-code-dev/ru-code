// ru-code PIN SUITE — boot-window pins, OUTDATED split (B3).
//
// Quarantined out of tests-performance/b-boot.perf.test.ts (née tests-pins/b-boot.pins.test.ts)
// — see ./README.md for why. The body is
// byte-identical to its origin; only a leading test.skip was added per the outdated-suite
// convention, plus the shared `coreInvariants` helper this case needs (duplicated from its
// origin file rather than editing test logic — the staying file keeps its own copy for
// B1/B2/B2b/B4/B5).
//
// Each pin dials one boot-time fault into a freshly-booted real app and asserts the CORE
// INVARIANTS: stable within budget, zero connection-error notifications across the observation
// window, and a `/ws` upgrade that is ANSWERED (any status) fast at every sample point.
//
// These tests REPORT; they fix nothing. A failure here is a finding about the app, not the suite.

import { expect, test } from "@playwright/test";

import {
  assertQuietFor,
  awaitStable,
  bootPin,
  buildAvShim,
  type PinnedApp,
  readDaemonLog,
  runPinCleanups,
  saveEvidence,
  upgradeAnswerMs,
} from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

/** The shared core-invariant block every boot pin runs after its own setup. */
async function coreInvariants(
  page: import("@playwright/test").Page,
  app: PinnedApp,
  label: string,
  options: {
    readonly stableBudgetMs?: number;
    readonly observeMs?: number;
    readonly upgradeBudgetMs?: number;
  } = {},
): Promise<void> {
  const observeMs = options.observeMs ?? 30_000;
  const upgradeBudget = options.upgradeBudgetMs ?? 2_000;

  await awaitStable(page, app, { budgetMs: options.stableBudgetMs ?? 60_000 });

  // Sample the upgrade path while the observation window runs: it must be ANSWERED promptly at
  // every point — an unauthenticated dial being refused is fine, a stall is the defect.
  const samples: number[] = [];
  const observation = (async () => {
    for (let i = 0; i < 3; i += 1) {
      const answer = await upgradeAnswerMs(app.port, { timeoutMs: 15_000 });
      samples.push(answer.ms);
      await new Promise((resolve) => setTimeout(resolve, observeMs / 3));
    }
  })();
  await assertQuietFor(page, observeMs, label);
  await observation;

  saveEvidence(
    `${label}-upgrade-samples.json`,
    JSON.stringify({ label, samples, daemonLogBytes: readDaemonLog(app).length }, null, 2),
  );
  for (const ms of samples)
    expect(ms, `${label}: /ws upgrade answer time`).toBeLessThan(upgradeBudget);
}

test("B3: AV-like filesystem latency (LD_PRELOAD open delay) must not disturb stability", async ({
  page,
}) => {
  test.skip(true, "outdated — see tests-outdated/README.md");
  const shim = buildAvShim();
  test.skip(shim === null, "environment-blocked: gcc/LD_PRELOAD shim unavailable");

  // ENGAGEMENT CHECK — the lever must provably bite a NODE process before the pin means anything.
  // On kernels where libuv routes fs ops through io_uring (or node uses direct syscalls), the
  // LD_PRELOAD hook never fires for node and a green run would be vacuous. Measured, not assumed:
  // a canary `node -e ""` under a large per-open delay must get visibly slower.
  const NodeChildProcess = await import("node:child_process");
  const canary = (env: NodeJS.ProcessEnv) => {
    const startedAt = Date.now();
    NodeChildProcess.spawnSync(process.execPath, ["-e", ""], { env, timeout: 60_000 });
    return Date.now() - startedAt;
  };
  const baselineMs = canary({ ...process.env });
  const delayedMs = canary({
    ...process.env,
    LD_PRELOAD: shim as string,
    PIN_AV_DELAY_US: "5000",
    UV_USE_IO_URING: "0",
  });
  test.skip(
    delayedMs < baselineMs + 2_000,
    `environment-limited: LD_PRELOAD does not engage for node fs on this kernel ` +
      `(baseline ${baselineMs}ms, delayed ${delayedMs}ms) — a faithful AV pin needs a FUSE ` +
      `passthrough filesystem; recorded as a finding, not silently skipped`,
  );

  const app = await bootPin({
    name: "b3-av-latency",
    env: {
      LD_PRELOAD: shim as string,
      UV_USE_IO_URING: "0",
      // 2ms per open(): thousands of opens per CLI cold start ≈ a corporate AV interception tax.
      PIN_AV_DELAY_US: "2000",
    },
    bootTimeoutMs: 180_000,
  });
  await coreInvariants(page, app, "B3", { stableBudgetMs: 120_000, upgradeBudgetMs: 5_000 });
});
