// ru-code: THE auto-update live-cycle integration suite (to-do.md §8.3 [L], E2E-B).
//
// Everything here is REAL: the real built server bundle, the real frozen wrapper + pointer +
// versions/ layout, the real daemon spawn chain (start → detached child → sentinel), the real
// hidden `update-relaunch` pinned-port hop, and a real local HTTP release server. The browser is
// NOT involved — /healthz + the on-disk journal/pointer/versions tree are the observable truth.
// (The real-BROWSER acceptance cycle is the sibling suite in browserCycle/, E2E-C.)
//
// RUN:  node ru-code/e2e/features/auto-update/liveCycle.ts     (from the repo root)
//   or as a step in the `test:e2e:all` chain (root package.json)
//
// Its reusable machinery (payload/layout assembly, the fixture release server, daemon boot/stop,
// on-disk observation) lives in ./shared.ts — extracted so browserCycle/ reuses it verbatim.
//
// STEP 0 — BUILD (once per run): shared.ensureServerBundle rebuilds the fat bundle ONLY when the
//   current apps/server/dist/bin.mjs lacks the live-cycle seams; the natives come from the existing
//   dist-bundle tarball. Version A and B are the SAME real bundle re-versioned (bumped slim
//   package.json + regenerated __checksums.json). Web static assets (client/) are omitted here —
//   irrelevant to /healthz + the auto-update observation; the browser suite carries them.
//
// THREE default-OFF src seams this suite needs (all env-gated, documented in-code, production
// behaviour byte-identical when unset):
//   · RU_CODE_UPDATE_TEST_VERSION_FROM_DIR=1 — /healthz + the engine's currentVersion read the
//     pointed version dir instead of the build-baked package.json.          [updateEngineLive / healthz]
//   · RU_CODE_UPDATE_TEST_TRIGGER=1 — arms a loopback POST route that drives ONE real press
//     (checkNow → install); the production press is the authenticated ws `install` RPC.  [apply/testTriggerRoute]
//   · RU_CODE_UPDATE_TEST_PIN_MS=<ms> — shrinks the pinned-port retry delay so the port-busy case
//     runs in seconds.                                                       [apply/updateRelaunch]
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { releaseTarballName } from "../../../branding/src/index.ts";

import {
  assert,
  assertEq,
  cleanups,
  getHealthz,
  holdPort,
  httpJson,
  log,
  poll,
  runAllCleanups,
  runNode,
} from "../../harness/primitives.ts";
import {
  buildLayout,
  prepareArtifacts,
  type Prepared,
  VERSION_A,
  VERSION_B,
} from "../../harness/artifacts.ts";
import { bootDaemon, stopDaemon } from "../../harness/daemon.ts";
import { listVersions, readJournal, readPointer, SEAM_MARKER } from "./observers.ts";
import { freshFixtureState, startFixture } from "./fixtureServer.ts";
import { specInstallStartsTheApp, specRealInstallScript } from "../../harness/installScript.ts";

// ── tiny reporter ────────────────────────────────────────────────────────────────────────────
interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}
const results: Array<CaseResult> = [];

function commonEnv(fixtureUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RU_CODE_UPDATE_WEB_URL: fixtureUrl,
    // The GIT source is BAKED to a real repository, and git is checked FIRST — so without this the
    // spawned server reaches the network on every check and the release verdict comes from whatever
    // that repo carries today, not from the fixture these specs are about. A closed loopback port
    // keeps the source OFFERED (the card still renders) while failing instantly, offline.
    RU_CODE_UPDATE_GIT_URL: "http://127.0.0.1:59998/repo.git",
    RU_CODE_UPDATE_TEST_VERSION_FROM_DIR: "1",
    RU_CODE_UPDATE_TEST_TRIGGER: "1",
    RU_CODE_UPDATE_TEST_PIN_MS: "600",
    ...extra,
  };
}

interface PressResult {
  readonly status: string;
  readonly runPhase: string | null;
  readonly errorCode: string | null;
  readonly refused: boolean;
}
/** POST the loopback test-trigger. Tolerates a reset response (the happy press self-SIGTERMs). */
async function press(port: number): Promise<PressResult | null> {
  const response = await httpJson(
    "POST",
    `http://127.0.0.1:${String(port)}/internal/auto-update/test-trigger`,
    60_000,
  );
  return response !== null && response.status === 200 ? (response.body as PressResult) : null;
}

// ── the specs ───────────────────────────────────────────────────────────────────────────────
type Spec = (prepared: Prepared) => Promise<string>;

const specCoreLiveCycle: Spec = async (prepared) => {
  const fixture = await startFixture(freshFixtureState(prepared));
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url);

  const bootA = await bootDaemon(layout, env, VERSION_A);
  assertEq(readPointer(layout.appRoot)?.version, VERSION_A, "pointer at A before press");

  await press(bootA.port); // fire; the happy press self-SIGTERMs A → tolerate a null response

  // old pid exits → relaunch → /healthz on the SAME port reports B + lastApply ok.
  const healthB = await poll(
    async () => {
      const h = await getHealthz(bootA.port);
      return h !== null && h.version === VERSION_B && h.lastApply?.outcome === "ok" ? h : null;
    },
    { timeoutMs: 90_000, intervalMs: 700, label: "healthz → version B + lastApply ok" },
  );

  assert(healthB.pid !== bootA.pid, "pid changed across the swap");
  assertEq(healthB.lastApply?.targetVersion, VERSION_B, "lastApply target B");
  assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer flipped to B");
  const journal = readJournal(layout.appRoot);
  assertEq(journal?.outcome, "ok", "journal outcome ok");
  assert(
    NodeFS.existsSync(NodePath.join(layout.appRoot, "updates", "relaunch.log")),
    "relaunch.log present in updates/",
  );
  const versions = listVersions(layout.appRoot);
  assertEq(versions.length, 1, "GC left exactly one version dir");
  assertEq(versions[0], VERSION_B, "GC left versions/B");
  assert(fixture.state.requests.length > 0, "fixture served requests");
  assert(
    fixture.state.requests.some((r) => r.startsWith(`/${releaseTarballName(VERSION_B)}`)),
    "tarball was downloaded",
  );
  return `swap A→B on port ${String(bootA.port)}, pid ${String(bootA.pid)}→${String(healthB.pid)}, GC=[${versions.join(",")}]`;
};

const specBreakCorruptArchive: Spec = async (prepared) => {
  const state = freshFixtureState(prepared);
  const corrupted = Buffer.from(prepared.cleanTarball);
  corrupted[Math.floor(corrupted.length / 2)] ^= 0xff; // flip a byte; manifest sha stays the clean sha
  state.tarball = corrupted;
  const fixture = await startFixture(state);
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url);
  const boot = await bootDaemon(layout, env, VERSION_A);

  const result = await press(boot.port);
  assert(result !== null, "press returned a result (no relaunch on failure)");
  assertEq(result?.runPhase, "failed", "run failed");
  assertEq(result?.errorCode, "archive-integrity", "archive-integrity code");
  assert(readPointer(layout.appRoot)?.version === VERSION_A, "pointer still A");
  const still = await getHealthz(boot.port);
  assert(
    still !== null && still.version === VERSION_A && still.pid === boot.pid,
    "app STILL running on A",
  );
  return `run failed archive-integrity; pointer A; app alive pid ${String(boot.pid)}`;
};

const specBreakCorruptFile: Spec = async (prepared) => {
  const state = freshFixtureState(prepared);
  state.tarball = prepared.fileCorruptTarball; // archive sha matches, one inner file mismatches __checksums
  state.sha = prepared.fileCorruptSha;
  const fixture = await startFixture(state);
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url);
  const boot = await bootDaemon(layout, env, VERSION_A);

  const result = await press(boot.port);
  assert(result !== null, "press returned a result");
  assertEq(result?.runPhase, "failed", "run failed");
  assertEq(result?.errorCode, "file-integrity", "file-integrity code");
  assert(readPointer(layout.appRoot)?.version === VERSION_A, "pointer still A");
  const still = await getHealthz(boot.port);
  assert(still !== null && still.pid === boot.pid, "app alive");
  return `run failed file-integrity (post-checksums tamper); pointer A; app alive`;
};

const specBreakMinNode: Spec = async (prepared) => {
  const state = freshFixtureState(prepared);
  state.minNode = ">=99"; // no host satisfies → refused BEFORE any download
  const fixture = await startFixture(state);
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url);
  const boot = await bootDaemon(layout, env, VERSION_A);

  const result = await press(boot.port);
  assert(result !== null, "press returned a result");
  assert(result?.refused === true, "install refused before a run");
  assertEq(result?.errorCode, "node-too-old", "node-too-old code");
  assert(
    !fixture.state.requests.some((r) => r.startsWith(`/${releaseTarballName(VERSION_B)}`)),
    "ZERO tarball requests",
  );
  assert(readPointer(layout.appRoot)?.version === VERSION_A, "pointer still A");
  const still = await getHealthz(boot.port);
  assert(still !== null && still.pid === boot.pid, "app alive");
  return `refused node-too-old before download (0 tarball requests); pointer A`;
};

const specBreakPortBusy: Spec = async (prepared) => {
  // Deterministic port-busy: press with NO_RELAUNCH so the pointer flips but nothing relaunches or
  // self-SIGTERMs; stop the server (freeing the port under OUR control); HOLD the port; then run the
  // REAL `update-relaunch` hop — its pinned gate finds the port busy and journals port-busy.
  const fixture = await startFixture(freshFixtureState(prepared));
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url, { RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1" });
  const boot = await bootDaemon(layout, env, VERSION_A);

  const result = await press(boot.port);
  assert(result !== null && result.refused === false, "press flipped the pointer (no relaunch)");
  assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer flipped to B");
  assertEq(readJournal(layout.appRoot)?.outcome, "started", "journal started after flip");

  await stopDaemon(layout, env); // free the port deterministically
  const release = await holdPort(boot.port); // then hold it

  const relaunch = await runNode(
    [
      NodePath.join(layout.appRoot, "cli.js"),
      "update-relaunch",
      "--port",
      String(boot.port),
      "--no-browser",
      "--base-dir",
      layout.baseDir,
    ],
    { env: commonEnv(fixture.url, { RU_CODE_UPDATE_TEST_PIN_MS: "400" }), timeoutMs: 30_000 },
  );
  assert(relaunch.code !== 0, "update-relaunch exits non-zero on a busy pinned port");

  const journal = await poll(
    async () => {
      const j = readJournal(layout.appRoot);
      return j?.outcome === "failed" && j?.reasonCode === "port-busy" ? j : null;
    },
    { timeoutMs: 15_000, intervalMs: 300, label: "journal → port-busy" },
  );
  await release();
  return `update-relaunch gave up on the pinned port → journal outcome=${String(journal.outcome)}/${String(journal.reasonCode)}`;
};

const specBreakRespawnerKilled: Spec = async (prepared) => {
  // RU_CODE_UPDATE_TEST_NO_RELAUNCH: the flip lands but nothing relaunches. A manual `start` must
  // converge on B through the flipped pointer, and the fresh boot promotes the journal to ok.
  const fixture = await startFixture(freshFixtureState(prepared));
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url, { RU_CODE_UPDATE_TEST_NO_RELAUNCH: "1" });
  const boot = await bootDaemon(layout, env, VERSION_A);

  const result = await press(boot.port);
  assert(result !== null && result.refused === false, "press ran the install");
  assertEq(readPointer(layout.appRoot)?.version, VERSION_B, "pointer flipped to B");
  assertEq(readJournal(layout.appRoot)?.outcome, "started", "journal started (relaunch skipped)");
  assert(
    NodeFS.existsSync(NodePath.join(layout.appRoot, "versions", VERSION_B)),
    "versions/B extracted",
  );

  await stopDaemon(layout, env); // the respawner never ran; take the old server down manually

  const rebooted = await bootDaemon(layout, env, VERSION_B); // wrapper follows the flipped pointer → B
  assertEq(rebooted.health.lastApply?.outcome, "ok", "journal promoted to ok on the fresh boot");
  const versions = listVersions(layout.appRoot);
  assertEq(versions.join(","), VERSION_B, "boot GC left only versions/B");
  return `manual start converged on B via the flipped pointer; journal promoted ok; GC=[${versions.join(",")}]`;
};

const specBreakCorruptPointer: Spec = async (prepared) => {
  const fixture = await startFixture(freshFixtureState(prepared));
  const layout = buildLayout(prepared, VERSION_A);
  const env = commonEnv(fixture.url);
  await bootDaemon(layout, env, VERSION_A);
  await stopDaemon(layout, env);

  // Corrupt current.json while stopped → the wrapper's fallback scan must still boot a valid version.
  NodeFS.writeFileSync(
    NodePath.join(layout.appRoot, "current.json"),
    "\x00\x01 not json at all }{",
  );
  const rebooted = await bootDaemon(layout, env, null); // seam sees a null pointer → baked version; just assert ok
  assert(rebooted.health.ok === true, "wrapper fallback booted a healthy server");
  return `corrupt current.json → wrapper fallback booted a healthy server (pid ${String(rebooted.pid)}, v${rebooted.health.version})`;
};

// ── driver ──────────────────────────────────────────────────────────────────────────────────
const SPECS: ReadonlyArray<{ readonly name: string; readonly spec: Spec }> = [
  {
    name: "REAL install script — bundle → bin/ layout → boot → repair reinstall keeps userdata",
    spec: specRealInstallScript,
  },
  {
    name: "REAL install as users run it (cat install | bash) — the app is RUNNING afterwards",
    spec: specInstallStartsTheApp,
  },
  {
    name: "CORE live cycle (build → install → wrapper layout → press → relaunch → /healthz B + journal ok + GC)",
    spec: specCoreLiveCycle,
  },
  {
    name: "break a — corrupt archive (sha mismatch) → archive-integrity, pointer A, app alive",
    spec: specBreakCorruptArchive,
  },
  {
    name: "break b — corrupt inner file (post-checksums) → file-integrity, pointer A, app alive",
    spec: specBreakCorruptFile,
  },
  {
    name: "break c — minNode >=99 → refused node-too-old, ZERO tarball requests, pointer A",
    spec: specBreakMinNode,
  },
  {
    name: "break d — pinned port stays busy → update-relaunch journals port-busy",
    spec: specBreakPortBusy,
  },
  {
    name: "break e — respawner killed → manual start converges on B via the flipped pointer",
    spec: specBreakRespawnerKilled,
  },
  {
    name: "break f — corrupt current.json → wrapper fallback boots a healthy server",
    spec: specBreakCorruptPointer,
  },
];

async function main(): Promise<void> {
  log("\n=== auto-update live-cycle integration (E2E-B, to-do.md §8.3) ===\n");
  const suiteStart = Date.now();
  const prepared = prepareArtifacts({ version: VERSION_B, seamMarker: SEAM_MARKER });

  for (const { name, spec } of SPECS) {
    const start = Date.now();
    // Each spec binds real ports + spawns real daemons — serial, with per-spec cleanup after it.
    const before = cleanups.length;
    try {
      const detail = await spec(prepared);
      const ms = Date.now() - start;
      results.push({ name, ok: true, ms, detail });
      log(`  ✔ ${name}  (${String(ms)}ms)\n      ${detail}`);
    } catch (error) {
      const ms = Date.now() - start;
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, ms, detail });
      log(`  ✗ ${name}  (${String(ms)}ms)\n      ${detail}`);
    } finally {
      // Tear down just this spec's daemons/servers (LIFO back to `before`), keep the shared cache.
      const own = cleanups.splice(before);
      for (const fn of own.toReversed()) {
        try {
          await fn();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  await runAllCleanups();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  log(
    `\n=== ${String(passed)}/${String(total)} passed in ${String(((Date.now() - suiteStart) / 1000).toFixed(1))}s ===`,
  );
  for (const r of results)
    log(`  ${r.ok ? "PASS" : "FAIL"}  ${String(r.ms).padStart(6)}ms  ${r.name}`);
  process.exit(passed === total ? 0 : 1);
}

process.on("SIGINT", () => {
  void runAllCleanups().finally(() => process.exit(130));
});

// Only self-run when invoked directly (browserCycle imports ./shared.ts, never this driver).
main().catch(async (error: unknown) => {
  log(`\nFATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  await runAllCleanups();
  process.exit(1);
});
