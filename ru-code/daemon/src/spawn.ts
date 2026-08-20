// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the platform-branched detached spawn — the core of backgrounding.
//
// POSIX: `detached: true` (new session via setsid) leaves the terminal's process
// group. Windows: NO `detached` — a Windows child already survives parent exit
// (no job object kills it), whereas `detached: true` there allocates a new console
// window. `unref()` lets our event loop exit while the child lives on. stdout+
// stderr go to the daemon log file.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";

import { isHostWindows } from "@t3tools/shared/hostProcess";

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
}): Effect.Effect<number, DaemonSpawnError> =>
  Effect.gen(function* () {
    const isWindows = yield* isHostWindows;
    return yield* Effect.try({
      try: () => {
        // ru-code: "w" truncates the log on every spawn (start / restart), so it
        // never grows unbounded. Reuse doesn't spawn, so it leaves the log intact.
        const logFd = NodeFS.openSync(params.logPath, "w");
        try {
          const child = NodeChildProcess.spawn(params.command, [...params.args], {
            detached: !isWindows,
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
  });
