// ru-code PIN SUITE — boot-window pins (B1–B5).
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
} from "./pinHarness.ts";

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

test("B1: slow CLI --version (45s) must not disturb connection stability", async ({ page }) => {
  const app = await bootPin({
    name: "b1-slow-version",
    env: { RU_CODE_PIN_VERSION_DELAY_MS: "45000" },
  });
  await coreInvariants(page, app, "B1", { observeMs: 50_000 });
  // Evidence: the probe genuinely ran long — the provider must not have blocked on it.
  saveEvidence("B1-daemon-log-tail.txt", readDaemonLog(app).slice(-8_000));
});

test("B2: slow warm-slot boot (45s, warm engine ON) must not disturb connection stability", async ({
  page,
}) => {
  const app = await bootPin({
    name: "b2-slow-warm",
    env: { RU_CODE_PIN_ACP_READY_DELAY_MS: "45000", RU_CODE_WARM_ENGINE: "1" },
  });
  await coreInvariants(page, app, "B2", { observeMs: 50_000 });
});

test("B2b: control — same boot with the warm engine off", async ({ page }) => {
  const app = await bootPin({
    name: "b2b-warm-off",
    env: { RU_CODE_PIN_ACP_READY_DELAY_MS: "45000", RU_CODE_WARM_ENGINE: "0" },
  });
  await coreInvariants(page, app, "B2b");
});

test("B3: AV-like filesystem latency (LD_PRELOAD open delay) must not disturb stability", async ({
  page,
}) => {
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

test("B4: hostile PATH (huge dir + dead entries) must not disturb stability", async ({ page }) => {
  const NodeFS = await import("node:fs");
  const NodePath = await import("node:path");
  const NodeOS = await import("node:os");
  const hugeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pin-hugepath-"));
  for (let i = 0; i < 5_000; i += 1) NodeFS.writeFileSync(NodePath.join(hugeDir, `f${i}`), "");
  const app = await bootPin({
    name: "b4-hostile-path",
    env: {
      PATH: [
        hugeDir,
        "/nonexistent-pin-a",
        "/nonexistent-pin-b",
        process.env.PATH ?? "/usr/bin",
      ].join(":"),
    },
  });
  await coreInvariants(page, app, "B4");
});

test("B5: the reproduction — slow CLI + slow warm + AV latency on ONE pinned core", async ({
  page,
}) => {
  const shim = buildAvShim();
  const app = await bootPin({
    name: "b5-all-faults",
    wrap: ["taskset", "-c", "0", "nice", "-n", "10"],
    env: {
      RU_CODE_PIN_VERSION_DELAY_MS: "45000",
      RU_CODE_PIN_ACP_READY_DELAY_MS: "45000",
      RU_CODE_WARM_ENGINE: "1",
      ...(shim !== null ? { LD_PRELOAD: shim, PIN_AV_DELAY_US: "1000" } : {}),
    },
    bootTimeoutMs: 300_000,
  });
  await coreInvariants(page, app, "B5", {
    stableBudgetMs: 180_000,
    observeMs: 60_000,
    upgradeBudgetMs: 5_000,
  });
});
