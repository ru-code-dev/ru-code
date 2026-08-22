// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the detached spawn — the core of backgrounding.
//
// POSIX: `detached: true` (new session via setsid) leaves the terminal's process
// group. Windows: `detached: true` maps to DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP —
// the child gets NO console, so closing the launching terminal (CTRL_CLOSE_EVENT)
// or Ctrl+C in it can never kill the server. DETACHED_PROCESS creates no window
// (a window would need CREATE_NEW_CONSOLE); every descendant spawn is hidden via
// windowsHide (the platform-node-shared patch). `unref()` lets our event loop
// exit while the child lives on. stdout+stderr go to the daemon log file.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";

export class DaemonSpawnError {
  readonly _tag = "DaemonSpawnError";
  readonly cause: unknown;
  constructor(options: { readonly cause: unknown }) {
    this.cause = options.cause;
  }
}

export const spawnDetachedServer = (params: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  /**
   * APPEND instead of truncating. A launch may spawn up to `MAX_LAUNCH_ATTEMPTS` children, and
   * truncating on each one destroyed the FIRST child's stack trace — the one that explains the
   * failure — leaving the log holding only the last, least informative attempt, while the failure
   * banner points the user at that file and the installer's own docs call it "the ONLY place a
   * failed launch's real error text lives". The first attempt of a launch still truncates, so the
   * log keeps describing the CURRENT launch and never grows unbounded.
   */
  readonly appendLog?: boolean;
}): Effect.Effect<number, DaemonSpawnError> =>
  Effect.try({
    try: () => {
      const logFd = NodeFS.openSync(params.logPath, params.appendLog === true ? "a" : "w");
      try {
        const child = NodeChildProcess.spawn(params.command, [...params.args], {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", logFd, logFd],
          env: params.env,
        });
        child.unref();
        if (child.pid === undefined) {
          throw new Error("spawn returned no pid");
        }
        return child.pid;
      } finally {
        // The child inherited its own dup of the fd; the parent drops its copy.
        NodeFS.closeSync(logFd);
      }
    },
    catch: (cause) => new DaemonSpawnError({ cause }),
  });
