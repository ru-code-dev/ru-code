// ru-code: MUST be first — seeds the process locale from --lang/--language/T3CODE_LANG
// before any effect/CLI flag descriptions (ours + the patched built-ins) are constructed,
// so `--help` honors the language. See ./ru-code/cliBootLocale.ts.
import "./ru-code/cliBootLocale.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import { APP_COMMAND, APP_NAME } from "@ru-code/branding";
import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";

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

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
