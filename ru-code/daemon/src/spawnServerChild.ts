// ru-code: spawn the detached server child on a concrete port. Encapsulates the
// re-exec detail — same node binary + node flags (process.execArgv preserves e.g.
// --experimental-sqlite), the CLI entry, the built child argv, and the env marker
// that tells the child "you are the server, don't re-daemonize".

import * as Effect from "effect/Effect";

import { buildChildArgs, type ForwardableServerFlags } from "./childArgs.ts";
import { DAEMON_CHILD_ENV } from "./constants.ts";
import { DaemonSpawnError, spawnDetachedServer } from "./spawn.ts";

export const spawnServerChild = (params: {
  readonly flags: ForwardableServerFlags;
  readonly baseDir: string;
  readonly host: string;
  readonly port: number;
  readonly logPath: string;
}): Effect.Effect<number, DaemonSpawnError> =>
  Effect.gen(function* () {
    const cliEntry = process.argv[1];
    if (cliEntry === undefined) {
      return yield* Effect.fail(
        new DaemonSpawnError({ cause: new Error("cannot resolve the CLI entry point") }),
      );
    }
    const childArgs = buildChildArgs({
      flags: params.flags,
      port: params.port,
      host: params.host,
      baseDir: params.baseDir,
    });
    return yield* spawnDetachedServer({
      command: process.execPath,
      args: [...process.execArgv, cliEntry, ...childArgs],
      env: { ...process.env, [DAEMON_CHILD_ENV]: "1" },
      logPath: params.logPath,
    });
  });
