// ru-code: E2E HARNESS — the PLUGINS suite's globalTeardown.
//
// Kills the app this run started and removes its temp isolation root. Two things it does NOT do,
// both on purpose:
//
//  · **No `pkill -f`.** The core suite's teardown sweeps grandchildren with a shell `pkill -f
//    <pattern>`; on this machine that pattern also matches the invoking shell's own argv, so it can
//    report (and kill) itself. Here every kill goes through a pid: the runner's own detached process
//    GROUP first (which is where the fake-ACP children live), then, for anything that escaped it, a
//    scoped `pgrep -f` listing whose pids are signalled one at a time — `execFileSync`, never a
//    shell string, so `pgrep` can never match the process asking the question.
//  · **No port assertion.** This suite binds no hardcoded port (the app's is reserved at boot), so
//    there is nothing a stranger could be holding that would make a clean run fail.
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  killIfStillOurs,
  PLUGINS_STATE_FILE,
  readPluginsHarnessState,
  type PluginsHarnessState,
} from "./pluginsBoot.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const BUILT_SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const FAKE_ACP_ENTRY = NodePath.join(
  REPO_ROOT,
  "apps/server/src/ru-code/tests/qwen/fake-acp/fake-acp-server.ts",
);

/** Pids whose argv contains `needle`, or `[]`. `execFileSync` — a shell string would self-match. */
function pidsMatching(needle: string): ReadonlyArray<number> {
  try {
    return NodeChildProcess.execFileSync("pgrep", ["-f", needle], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches — the clean case
  }
}

export default async function stopPluginsApp(): Promise<void> {
  let state: PluginsHarnessState | null = null;
  try {
    state = readPluginsHarnessState();
  } catch {
    return; // boot never got far enough to write one
  }

  if (state.runnerPid > 0) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(-state.runnerPid, signal);
      } catch {
        break; // already gone
      }
      await new Promise((resolve) => setTimeout(resolve, signal === "SIGTERM" ? 2_000 : 0));
    }
    killIfStillOurs(state.runnerPid, BUILT_SERVER_ENTRY);
  }

  // Anything that outlived the group — one pid at a time, both needles scoped to THIS worktree's
  // absolute paths so an unrelated app the user runs elsewhere is never touched.
  for (const needle of [BUILT_SERVER_ENTRY, FAKE_ACP_ENTRY]) {
    for (const pid of pidsMatching(needle)) killIfStillOurs(pid, needle);
  }

  if (NodePath.basename(state.tmpRoot).startsWith("ru-code-e2e-plugins-")) {
    NodeFS.rmSync(state.tmpRoot, { recursive: true, force: true });
  }
  // Nothing this file describes is alive any more; leaving it behind is what turns the next boot's
  // reclaim step into a lie.
  NodeFS.rmSync(PLUGINS_STATE_FILE, { force: true });
}
