import { APP_NAME } from "@ru-fork/branding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { initSpawnPolicy } from "../ru-fork/spawn/policy.ts";
import { runPreflight } from "../ru-fork/startup/preflight.ts";
// ru-fork: only the server-launching path probes port availability;
// other CLI subcommands (auth, project) reach config without binding.
import { assertLocalPortAvailable } from "../ru-fork/local-startup/assertLocalPortAvailable.ts";
import { DESKTOP_RUNTIME_MODE } from "../ru-fork/local-startup/defaults.ts";
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
    // ru-fork: spawn policy must be set before any spawn (preflight
    // itself spawns CLI + git). See
    // ru-fork-instrumental/changes/startap-environment.md.
    initSpawnPolicy({
      injectExtraPaths: Option.getOrUndefined(flags.injectExtraPaths),
      windowsUseBashFor: Option.getOrUndefined(flags.windowsUseBashFor),
    });
    // ru-fork: hard gate on node/git/CLI. Skipped when the daemon
    // launcher already ran it in the parent and passed
    // --no-preflight-check to this spawned child. See
    // `ru-fork-instrumental/changes/deamon/startap-checks.md`.
    if (!Option.getOrElse(flags.noPreflightCheck, () => false)) {
      yield* runPreflight;
    }
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    // ru-fork: desktop mode pins the port (no findAvailablePort
    // fallback), so verify it's free before the listener layer tries to
    // bind. Failure surfaces as the Russian PortInUseError instead of an
    // EADDRINUSE stack. Web mode already picked a free port via
    // findAvailablePort during resolveServerConfig — no probe needed.
    // Probe lives here (not inside resolveServerConfig) so other CLI
    // subcommands that read the config (auth, project) don't trip it.
    if (config.mode === DESKTOP_RUNTIME_MODE) {
      yield* assertLocalPortAvailable(config.port);
    }
    // ru-fork: wire the resolved log level into Effect's default logger.
    // Without this, Effect keeps its built-in "Info" minimum and the
    // RU_FORK_LOG_LEVEL env var / --log-level flag have no effect on
    // server startup.
    return yield* runServer.pipe(
      Effect.provideService(ServerConfig, config),
      Effect.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(`Run the ${APP_NAME} server in the foreground (full console output).`),
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
