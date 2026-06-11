import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import {
  baseDirFlag,
  type CliServerFlags,
  devUrlFlag,
  sharedServerCommandFlags,
} from "./cli/config.ts";
import { probeTtyCommand } from "./cli/probeTty.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { runDaemonLauncher, runStopCommand } from "./daemonLauncher.ts";
import { OpenLive } from "./open.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, OpenLive);

const stopCommand = Command.make("stop", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
}).pipe(
  Command.withDescription("Stop a background ru-fork server started by `ru-fork`."),
  Command.withHandler((flags) =>
    runStopCommand({
      baseDirOverride: Option.getOrUndefined(flags.baseDir),
      devUrlOverride: Option.getOrUndefined(flags.devUrl),
    }),
  ),
);

// Drop tokens we must NOT pass through to the spawned child:
//   --bootstrap-fd  references a fd that doesn't survive a detached spawn.
//   --no-browser    the launcher always re-adds it; forwarding the user's
//                   copy too would produce a duplicate flag and may break
//                   the CLI parser.
//   --no-preflight-check  same — the launcher always re-adds it for the
//                   spawned child (so the parent's preflight isn't repeated).
const STRIPPED_FLAGS_WITH_VALUE = new Set(["--bootstrap-fd"]);
const STRIPPED_BOOLEAN_FLAGS = new Set(["--no-browser", "--no-preflight-check"]);

const sanitizeForwardedArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (STRIPPED_FLAGS_WITH_VALUE.has(token)) {
      i += 1; // skip the value too
      continue;
    }
    if (STRIPPED_BOOLEAN_FLAGS.has(token)) continue;
    if (
      [...STRIPPED_FLAGS_WITH_VALUE, ...STRIPPED_BOOLEAN_FLAGS].some((f) =>
        token.startsWith(`${f}=`),
      )
    ) {
      continue;
    }
    out.push(token);
  }
  return out;
};

const argvHasMode = (argv: ReadonlyArray<string>): boolean =>
  argv.some((token) => token === "--mode" || token.startsWith("--mode="));

// Bare `ru-fork` (daemon path) defaults to desktop mode: server binds
// loopback only and the auth gate auto-issues sessions for loopback requests
// (see auth/Layers/ServerAuth.ts). This is the local-laptop trust model —
// it makes the app survive cookie-wipe-on-close, and it
// keeps `--mode web` working when the user explicitly opts into LAN access.
// Foreground `start` is unaffected because it parses argv via the explicit
// command, not this launcher.
const withDaemonModeDefault = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argvHasMode(argv) ? argv : ["--mode", "desktop", ...argv];

const runDaemonLauncherCommand = (flags: CliServerFlags) =>
  // ru-fork: Windows can't reliably run the detached-daemon design on
  //  — IPv4/IPv6 binding races plus detached-
  // child flakiness (nodejs/node#21825). Fall through to foreground server:
  // same code path as `ru-fork start`, known-good. Terminal stays
  // attached until Ctrl+C — acceptable trade-off versus "doesn't work."
  //
  // Wrapped in Effect.gen with `return yield*` so the union of the two
  // branches' error/requirement channels resolves correctly for
  // Command.withHandler (a bare ternary fails the assignment because TS
  // tries to narrow the union into one branch's type).
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return yield* runServerCommand(flags);
    }
    return yield* runDaemonLauncher({
      baseDirOverride: Option.getOrUndefined(flags.baseDir),
      devUrlOverride: Option.getOrUndefined(flags.devUrl),
      forwardedArgs: withDaemonModeDefault(sanitizeForwardedArgv(process.argv.slice(2))),
      noBrowser: Option.getOrElse(flags.noBrowser, () => false),
      // ru-fork: forward the preflight skip flag to the launcher.
      noPreflightCheck: Option.getOrElse(flags.noPreflightCheck, () => false),
      // ru-fork: forward spawn-policy flags to the launcher.
      injectExtraPaths: Option.getOrUndefined(flags.injectExtraPaths),
      windowsUseBashFor: Option.getOrUndefined(flags.windowsUseBashFor),
    });
  });

export const cli = Command.make("ru-fork", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Start ru-fork in the background. The log path is printed on first run. " +
      "Re-run to open the browser to the running server. " +
      "Use `ru-fork stop` to stop it. " +
      "Use `ru-fork start` to run in the foreground.",
  ),
  Command.withHandler((flags) => runDaemonLauncherCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    stopCommand,
    authCommand,
    projectCommand,
    probeTtyCommand,
  ]),
);

// ru-fork: `import.meta.main` is Node 22.18+; engines floor is 22.6 for
// IT-locked users, so fall back to comparing argv[1] against this module's path.
const isMainModule =
  (import.meta as { main?: boolean }).main ?? process.argv[1] === import.meta.filename;

if (isMainModule) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
