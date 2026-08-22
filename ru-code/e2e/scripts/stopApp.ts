// ru-code: globalTeardown — kills the dev-runner's whole process group (server +
// web + fake children) and removes the temp isolation root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const STATE_FILE = NodePath.join(import.meta.dirname, "../.artifacts/harness-state.json");

export default async function stopApp(): Promise<void> {
  if (!NodeFS.existsSync(STATE_FILE)) return;
  const state = JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) as {
    runnerPid: number;
    tmpRoot: string;
  };
  if (state.runnerPid > 0) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        // Negative pid = the detached process group.
        process.kill(-state.runnerPid, signal);
      } catch {
        break; // already gone
      }
      await new Promise((r) => setTimeout(r, signal === "SIGTERM" ? 2_000 : 0));
    }
  }
  // Detached grandchildren (warm-pool fake CLIs, vite workers) can outlive the
  // runner's process group — sweep them by command line, SCOPED to THIS
  // worktree's path so an unrelated dev-runner the user runs elsewhere is
  // never touched.
  const { execSync } = await import("node:child_process");
  const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
  for (const pattern of [`${repoRoot}/.*fake-acp-server.ts`, `${repoRoot}/.*dev-runner.ts`]) {
    try {
      execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    } catch {
      // no matches — fine
    }
  }
  // The suite is stable — remove the per-run isolation root (HOME/T3CODE_HOME,
  // fake CLI config, transcripts). Failed runs still leave .artifacts/ behind.
  if (state.tmpRoot.length > 0 && NodePath.basename(state.tmpRoot).startsWith("ru-code-e2e-")) {
    NodeFS.rmSync(state.tmpRoot, { recursive: true, force: true });
  }
}
