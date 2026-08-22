import * as Effect from "effect/Effect";
import * as Option from "effect/Option"; // ru-code: read the launcher-only --json flag
import { Command, GlobalFlag } from "effect/unstable/cli";

import { APP_NAME } from "@ru-code/branding";
import * as Daemon from "@ru-code/daemon"; // ru-code: daemon-by-default routing

import packageJson from "../../package.json" with { type: "json" }; // ru-code: banner version
import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    // ru-code: daemon-by-default. bare `ru-code` and `start` background themselves
    // via @ru-code/daemon; the headless `serve` path, the spawned child (env
    // marker), and --foreground all skip it and run the server here in-process.
    // See specs/daemon/seam-map.md.
    if (Daemon.shouldDaemonize(flags, options)) {
      return yield* Daemon.launchDaemon({
        flags,
        statePath: config.serverRuntimeStatePath,
        baseDir: config.baseDir,
        version: packageJson.version,
        // ru-code: --json is a launcher-parent-only contract for the installer.
        jsonOutput: Option.getOrElse(flags.json ?? Option.none(), () => false),
      });
    }
    // ru-code: record what the daemon child booted with, into daemon.log. No-op in
    // every other launch mode. Makes "works under --fg, fails as a daemon" reports
    // answerable from the log instead of by inference.
    yield* Daemon.reportBootEnvironment();
    // ru-code: single-instance guard — `serve`/`--foreground`/desktop bypass the
    // daemon's reuse gate and would otherwise start NEXT TO a running daemon on a
    // free port, clobbering the shared state file + pid journals. Refuses (with
    // a localized message) when the recorded instance is alive AND listening; the
    // spawned daemon child is exempt (env marker).
    yield* Daemon.ensureSingleInstance(config.serverRuntimeStatePath);
    // ru-code: second-signal escape hatch. The FIRST Ctrl+C/SIGTERM reaches the
    // Effect runtime untouched — the app's own teardown kills its ACP children.
    // A SECOND signal hard-exits (the runtime otherwise ignores repeats — a hung
    // finalizer would trap the terminal); orphans are journal-reaped on next start.
    yield* Effect.sync(() => Daemon.installSecondSignalHardExit());
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(`Run the ${APP_NAME} server.`),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    `Run the ${APP_NAME} server without opening a browser and print headless pairing details.`,
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
