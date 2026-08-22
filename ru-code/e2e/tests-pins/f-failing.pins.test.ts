// ru-code PIN SUITE — failing-CLI pins (F1–F4).
//
// The CLI does not merely run slow here — it BREAKS: `--version` errors out, the ACP entry exits
// before the handshake, or both, with delays stacked on top. What is under test is the blast
// radius: a broken provider CLI must cost the user provider features, never the CONNECTION — and
// the warm pool / probe machinery must retry boundedly (a respawn storm is itself a defect, even
// when the app stays up).
//
// Bounded-retry evidence comes from the spawn log: pinFakeCli appends one line per invocation, so
// the count over a window separates "breaker did its job" from "spawn storm".

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import {
  assertQuietFor,
  awaitStable,
  bootPin,
  type PinnedApp,
  readDaemonLog,
  runPinCleanups,
  saveEvidence,
  upgradeAnswerMs,
} from "./pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Boot with the per-invocation spawn log wired (its path is minted BEFORE the boot). */
async function bootFailing(
  label: string,
  env: Record<string, string>,
): Promise<{ app: PinnedApp; spawns: () => ReadonlyArray<string> }> {
  const NodeOS = await import("node:os");
  const logPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `pin-spawnlog-${label}-`)),
    "spawns.log",
  );
  const app = await bootPin({
    name: label,
    env: { ...env, RU_CODE_PIN_SPAWN_LOG: logPath },
  });
  return {
    app,
    spawns: () => {
      try {
        return NodeFS.readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line !== "");
      } catch {
        return [];
      }
    },
  };
}

test("F1: --version FAILS → provider degrades, connection untouched", async ({ page }) => {
  const { app, spawns } = await bootFailing("f1-version-fail", {
    RU_CODE_PIN_VERSION_FAIL: "1",
    RU_CODE_WARM_ENGINE: "0",
  });
  await awaitStable(page, app);
  await assertQuietFor(page, 30_000, "F1");
  const answer = await upgradeAnswerMs(app.port, { timeoutMs: 10_000 });
  expect(answer.ms, "upgrade answer with a failing --version").toBeLessThan(2_000);

  const versionSpawns = spawns().filter((line) => line.includes("--version"));
  saveEvidence("F1-evidence.json", JSON.stringify({ versionSpawns }, null, 2));
  // Failed probes are deliberately NOT cached (versionProbeCache) — refreshes may retry. Retrying
  // is legal; a STORM is not. Generous bound: boot + a few refresh cycles.
  expect(versionSpawns.length, "bounded --version retries").toBeLessThanOrEqual(12);
});

test("F2: ACP entry FAILS instantly (warm pool ON) → no storm, connection untouched", async ({
  page,
}) => {
  const { app, spawns } = await bootFailing("f2-acp-fail", {
    RU_CODE_PIN_ACP_FAIL: "1",
    RU_CODE_WARM_ENGINE: "1",
  });
  await awaitStable(page, app);
  await assertQuietFor(page, 40_000, "F2");

  const acpSpawns = spawns().filter((line) => !line.includes("--version"));
  saveEvidence(
    "F2-evidence.json",
    JSON.stringify({ acpSpawns, daemonLogTail: readDaemonLog(app).slice(-4_000) }, null, 2),
  );
  // The pool's own contract: refill only after a successful bind + a refill breaker. A crashing
  // CLI must converge to a small, bounded number of attempts — dozens means the breaker is dead.
  expect(acpSpawns.length, "bounded warm-slot attempts against a crashing CLI").toBeLessThanOrEqual(
    12,
  );
});

test("F3: ACP entry SLOW (20s) then FAILS (warm pool ON) → no storm, connection untouched", async ({
  page,
}) => {
  const { app, spawns } = await bootFailing("f3-acp-slow-fail", {
    RU_CODE_PIN_ACP_READY_DELAY_MS: "20000",
    RU_CODE_PIN_ACP_FAIL: "1",
    RU_CODE_WARM_ENGINE: "1",
  });
  await awaitStable(page, app);
  // The slow-failure worst case: each attempt occupies a slot for 20s and then dies. Observe a
  // window long enough for several cycles.
  await assertQuietFor(page, 60_000, "F3");

  const acpSpawns = spawns().filter((line) => !line.includes("--version"));
  saveEvidence("F3-evidence.json", JSON.stringify({ acpSpawns }, null, 2));
  expect(acpSpawns.length, "bounded slow-failing warm attempts").toBeLessThanOrEqual(10);
});

test("F4: --version SLOW (45s) AND FAILS → probe churn documented, connection untouched", async ({
  page,
}) => {
  const { app, spawns } = await bootFailing("f4-version-slow-fail", {
    RU_CODE_PIN_VERSION_DELAY_MS: "45000",
    RU_CODE_PIN_VERSION_FAIL: "1",
    RU_CODE_WARM_ENGINE: "0",
  });
  await awaitStable(page, app);
  await assertQuietFor(page, 60_000, "F4");
  const answer = await upgradeAnswerMs(app.port, { timeoutMs: 10_000 });
  expect(answer.ms, "upgrade answer during slow failing probes").toBeLessThan(2_000);

  // Churn documentation: a slow FAILING probe is the uncached worst case — every refresh pays the
  // full delay and learns nothing. The count is evidence for the report (and a tripwire against
  // an outright storm), not a statement that the current cadence is good.
  const versionSpawns = spawns().filter((line) => line.includes("--version"));
  saveEvidence("F4-evidence.json", JSON.stringify({ versionSpawns }, null, 2));
  await sleep(1_000);
  expect(versionSpawns.length, "not an unbounded probe storm").toBeLessThanOrEqual(12);
});
