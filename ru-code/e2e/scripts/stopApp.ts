// ru-code: globalTeardown — kills the built app's whole process group (server +
// web + fake children) and removes the temp isolation root.
//
// Two state files are read, and the SMALLER one matters most: `fake-pixso-pid.json` is
// written the instant the fake Pixso MCP spawns, whereas `harness-state.json` is written
// LAST. A boot that failed in between leaves no harness state at all, and the fake — which
// holds the HARDCODED port 3667 — would survive to poison the next run. Every kill is
// identity-checked (`killIfStillOurs`): pids are recycled, and a state file that outlived
// its run must never SIGKILL a stranger.
//
// FND-4 (decisions 528, queue/10 item 4): the needle below used to be computed
// INDEPENDENTLY of what `bootApp.ts` actually spawns — `bootApp.ts` spawns
// `FAKE_PIXSO_ENTRY_PATH` (the RESOLVED `ru-code-packages` symlink path,
// `harness/fakePixsoMcp.ts:29-31`), while this file recomputed its own needle as the
// harness RE-EXPORT wrapper's own path. `args.includes(needle)` in `killIfStillOurs`
// below therefore never matched, and every APP e2e run leaked the fake MCP process
// holding port 3667 (proven across 4 runner sweeps, including a fully passing run —
// see `WORKFLOW/current/findings/FND-4-fake-mcp-orphan-teardown.md`). The fix is ONE
// FUNNEL: import the SAME constant `bootApp.ts` spawns with, never a second spelling.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { killIfStillOurs } from "./bootApp.ts";
import { FAKE_PIXSO_ENTRY_PATH } from "../harness/fakePixsoMcp.ts";

const ARTIFACTS_DIR = NodePath.join(import.meta.dirname, "../.artifacts");
const STATE_FILE = NodePath.join(ARTIFACTS_DIR, "harness-state.json");
// T10 (reorg wave, decisions 438/442): ONE pid file — the merged fake Pixso MCP serves
// BOTH the local (`/local-mcp`) and remote (`/remote-mcp`) routes from one process.
const PIXSO_PID_FILE = NodePath.join(ARTIFACTS_DIR, "fake-pixso-pid.json");
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const BUILT_APP_ENTRY = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const MOCK_UPDATE_ENTRY = NodePath.join(import.meta.dirname, "mockUpdateServer.ts");
const FAKE_PIXSO_ENTRY = FAKE_PIXSO_ENTRY_PATH;

// F5 (branch-sync v5): mirrors bootApp.ts's own gate — teardown must not chase, pkill, or
// assert-clean a process it never spawned. playwright.pixso.config.ts sets this before
// importing bootApp.ts/stopApp.ts; every other suite leaves it unset.
const PIXSO_ENABLED = process.env["RU_CODE_E2E_PIXSO"] === "1";

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const FAKE_PIXSO_PORT = 3667;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * THE CLASS GATE (FND-4, queue/10 item 6). Teardown is not done because the kill
 * commands above RAN — it's done when nothing is actually left alive to prove it. Waits
 * a short grace window (SIGKILL is async) then asserts, mechanically: zero surviving
 * process anywhere still carries `FAKE_PIXSO_ENTRY` in its argv, AND port 3667 is free.
 * A regression that re-splits the needle (FND-4's own bug, reintroduced) fails LOUD here
 * — the next run's boot no longer has to discover the leak by hitting `EADDRINUSE`.
 *
 * `execFileSync` on purpose, never `execSync` with a shell STRING: `execSync` always
 * runs the command through `/bin/sh -c "<command>"`, and that shell's OWN argv then
 * contains the needle too (it is right there in the command string) — `pgrep -f` matches
 * ANY process whose command line contains the pattern, so it matched its own invoking
 * shell and reported a live "survivor" that was actually itself, on every run, even
 * fully clean ones. Caught own-hand by bisecting with a temporary debug trace (three
 * checkpoints through the kill sequence) before trusting the failure as real: the fake
 * was confirmed dead (`(none)`) after `killIfStillOurs` AND after the runner-kill loop,
 * then reappeared as `/bin/sh -c pgrep -af "<needle>"` the moment a shell-string
 * `pgrep` ran — the "leak" was the check, not the process. `execFileSync` execs `pgrep`
 * directly, no intermediate shell, no self-match.
 */
async function assertTeardownComplete(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const survivorsOf = (): string => {
    try {
      return execFileSync("pgrep", ["-f", FAKE_PIXSO_ENTRY], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return ""; // pgrep exits 1 when nothing matches — the clean case
    }
  };
  const deadline = Date.now() + 2_000;
  for (;;) {
    const survivors = survivorsOf();
    const portFree = await isPortFree(FAKE_PIXSO_PORT);
    if (survivors === "" && portFree) return;
    if (Date.now() > deadline) {
      const reasons: string[] = [];
      if (survivors !== "") {
        reasons.push(
          `fakePixsoMcp process(es) still alive (pid ${survivors.split("\n").join(", ")})`,
        );
      }
      if (!portFree) reasons.push(`port ${String(FAKE_PIXSO_PORT)} still bound`);
      throw new Error(`teardown incomplete: ${reasons.join("; ")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export default async function stopApp(): Promise<void> {
  const early = readJson(PIXSO_PID_FILE);
  const state = readJson(STATE_FILE);

  // ru-code: stop the detached side servers (each in its own process group). The early
  // file is honoured even when the full state file never got written.
  // F5: both pixso kills are gated — a non-pixso run never spawned it.
  if (PIXSO_ENABLED) {
    killIfStillOurs(Number(early?.["pid"] ?? -1), FAKE_PIXSO_ENTRY);
    killIfStillOurs(Number(state?.["pixsoServerPid"] ?? -1), FAKE_PIXSO_ENTRY);
  }
  killIfStillOurs(Number(state?.["mockServerPid"] ?? -1), MOCK_UPDATE_ENTRY);

  const runnerPid = Number(state?.["runnerPid"] ?? -1);
  if (runnerPid > 0) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        // Negative pid = the detached process group.
        process.kill(-runnerPid, signal);
      } catch {
        break; // already gone
      }
      await new Promise((r) => setTimeout(r, signal === "SIGTERM" ? 2_000 : 0));
    }
  }
  // Detached grandchildren (warm-pool fake CLIs, vite workers) can outlive the
  // runner's process group — sweep them by command line, SCOPED to THIS
  // worktree's path so an unrelated app the user runs elsewhere is
  // never touched. Every entry is spawned by ABSOLUTE path, which is what makes the
  // scoping real: a relatively-spawned runner never matched this pattern at all.
  const { execSync } = await import("node:child_process");
  // F5: the FAKE_PIXSO_ENTRY pattern is only meaningful for the pixso suite.
  const sweepPatterns = [
    `${REPO_ROOT}/.*fake-acp-server.ts`,
    BUILT_APP_ENTRY,
    MOCK_UPDATE_ENTRY,
    ...(PIXSO_ENABLED ? [FAKE_PIXSO_ENTRY] : []),
  ];
  for (const pattern of sweepPatterns) {
    try {
      execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    } catch {
      // no matches — fine
    }
  }
  // The suite is stable — remove the per-run isolation root (HOME/T3CODE_HOME,
  // fake CLI config, transcripts). Failed runs still leave .artifacts/ behind.
  const tmpRoot = String(state?.["tmpRoot"] ?? "");
  if (tmpRoot.length > 0 && NodePath.basename(tmpRoot).startsWith("ru-code-e2e-")) {
    NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
  }
  // Nothing described by these files is alive any more — leaving them behind is what
  // turns the next boot's readiness probe into a lie.
  NodeFS.rmSync(PIXSO_PID_FILE, { force: true });
  NodeFS.rmSync(STATE_FILE, { force: true });

  // F5: a stranger holding 3667 must never fail a non-pixso run's teardown — this suite
  // never spawned anything there and has no business asserting the port is free.
  if (PIXSO_ENABLED) await assertTeardownComplete();
}
