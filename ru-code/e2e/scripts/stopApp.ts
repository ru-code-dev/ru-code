// ru-code: globalTeardown — kills the built app's whole process group (server +
// web + fake children) and removes the temp isolation root.
//
// Every kill is identity-checked (`killIfStillOurs`): pids are recycled, and a state
// file that outlived its run must never SIGKILL a stranger.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { killIfStillOurs } from "./bootApp.ts";

const ARTIFACTS_DIR = NodePath.join(import.meta.dirname, "../.artifacts");
const STATE_FILE = NodePath.join(ARTIFACTS_DIR, "harness-state.json");
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const BUILT_APP_ENTRY = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const MOCK_UPDATE_ENTRY = NodePath.join(import.meta.dirname, "mockUpdateServer.ts");

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export default async function stopApp(): Promise<void> {
  const state = readJson(STATE_FILE);

  // ru-code: stop the detached side servers (each in its own process group).
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
  for (const pattern of [`${REPO_ROOT}/.*fake-acp-server.ts`, BUILT_APP_ENTRY, MOCK_UPDATE_ENTRY]) {
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
  // Nothing described by this file is alive any more — leaving it behind is what
  // turns the next boot's readiness probe into a lie.
  NodeFS.rmSync(STATE_FILE, { force: true });
}
