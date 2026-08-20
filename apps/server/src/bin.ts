// ru-code: MUST be first — seeds the process locale from --lang/--language/T3CODE_LANG
// before any effect/CLI flag descriptions (ours + the patched built-ins) are constructed,
// so `--help` honors the language. See ./ru-code/cliBootLocale.ts.
import "./ru-code/cliBootLocale.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Argument, Command, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
// oxlint-disable-next-line t3code/namespace-node-imports -- named `pathToFileURL` import kept for Node 22.16 compatibility
import { pathToFileURL } from "node:url";

import { APP_COMMAND, APP_NAME } from "@ru-code/branding";
import * as Daemon from "@ru-code/daemon"; // ru-code: `stop` subcommand
import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";

// ru-code: `ru-code stop` — resolve the state path via the app config, then
// delegate the pid kill/drain to @ru-code/daemon. See specs/daemon/seam-map.md.
const stopCommand = Command.make("stop", {
  ...sharedServerCommandFlags,
  force: Daemon.forceFlag,
}).pipe(
  Command.withDescription(`Stop the background ${APP_NAME} server.`),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* Daemon.stopDaemon({
        statePath: config.serverRuntimeStatePath,
        force: Option.getOrElse(flags.force, () => false),
      });
    }),
  ),
);

// ru-code: `ru-code restart` — stop (server + children) then start fresh.
const restartCommand = Command.make("restart", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(`Restart the background ${APP_NAME} server.`),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* Daemon.restartDaemon({
        flags,
        statePath: config.serverRuntimeStatePath,
        baseDir: config.baseDir,
        version: packageJson.version,
      });
    }),
  ),
);

// ru-code: hidden `ru-code env-analysis` — read-only probe of this machine's
// process-enumeration + kill capabilities (see @ru-code/daemon/envAnalysis).
const envAnalysisCommand = Command.make("env-analysis", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Probe process/kill capabilities of this machine (read-only)."),
  Command.withHidden,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* Daemon.runEnvAnalysis({ statePath: config.serverRuntimeStatePath });
    }),
  ),
);

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.string("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        // ru-code: brand the CLI program name (was "t3") — drives --help/error text.
        commandPath: [APP_COMMAND, "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  // ru-code: brand the root CLI program name (was "t3") → shown in --version/--help.
  Command.make(APP_COMMAND, { ...sharedServerCommandFlags }).pipe(
    Command.withDescription(`Run the ${APP_NAME} server.`),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      stopCommand, // ru-code: daemon stop
      restartCommand, // ru-code: daemon restart
      envAnalysisCommand, // ru-code: hidden capability probe

      // ru-code: `auth`, `project`, `pair` and `service` stay fully invocable but are
      // hidden from --help / completions (Command.withHidden), not removed. `pair` and
      // `service` are hidden because their upstream descriptions carry the T3 Code brand
      // and `service` is Linux/systemd-only, so neither belongs in the installed app's help.
      pairCommand.pipe(Command.withHidden),
      authCommand.pipe(Command.withHidden),
      projectCommand.pipe(Command.withHidden),
      serviceCommand.pipe(Command.withHidden),
      servicePreflightCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();

// ru-code: import.meta.main only exists on node >= 22.18 — on 22.16 it is undefined and
// the CLI silently never starts. Fall back to the argv entry-module comparison.
if (import.meta.main ?? pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
