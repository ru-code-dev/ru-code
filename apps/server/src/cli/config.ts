import * as NetService from "@t3tools/shared/Net";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import {
  type PreflightResolution,
  resolveStartupCli,
} from "../ru-fork/preflight/preflight-startup.ts";
// ru-fork: unified local-startup defaults.
import { DESKTOP_LOOPBACK_HOST, DESKTOP_RUNTIME_MODE } from "../ru-fork/local-startup/defaults.ts";
// ru-fork: --base-url normalization (path or full-URL accepted).
import { normalizeBasePath } from "../ru-fork/basePath/basePath.ts";

export const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to RU_FORK_HOME)."),
  Flag.optional,
);
export const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
// ru-fork: --base-url. Accepts a full URL or a bare path; only the
// pathname survives normalization. Empty when absent. See
// `ru-fork/basePath/basePath.ts` for the parser.
export const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription(
    "URL path prefix for reverse-proxy deployments (e.g. /services/u001/my-app, or full URL). Equivalent to RU_FORK_BASE_URL.",
  ),
  Flag.optional,
);
export const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
// ru-fork: skip the node/git/CLI preflight gate. The daemon
// launcher passes this to the spawned child so the gate runs once in
// the parent. End users can pass it for debugging. See
// `ru-fork-instrumental/changes/deamon/startap-checks.md`.
export const noPreflightCheckFlag = Flag.boolean("no-preflight-check").pipe(
  Flag.withDescription(
    "Skip the node/git/CLI dependency check (used internally by the daemon launcher).",
  ),
  Flag.optional,
);
// ru-fork: prepend extra dirs to PATH on all platforms. Comma-
// separated. Solves "CLI lives under %USERPROFILE%\... and cmd.exe
// doesn't see it" without hardcoding install locations in source.
// Equivalent to RU_FORK_INJECT_EXTRA_PATHS. See
// ru-fork-instrumental/changes/startap-environment.md.
export const injectExtraPathsFlag = Flag.string("inject-extra-paths").pipe(
  Flag.withDescription("Prepend directories to PATH (comma-separated, all platforms)."),
  Flag.optional,
);
// ru-fork: route selected binaries through `bash -c` on Windows
// instead of cmd.exe / shell:true. Use when cmd.exe path is blocked
// by AppLocker / Constrained-Language PowerShell / EDR, or when only
// a POSIX shim exists (no `.cmd`). Equivalent to
// RU_FORK_WINDOWS_USE_BASH_FOR.
export const windowsUseBashForFlag = Flag.string("windows-use-bash-for").pipe(
  Flag.withDescription(
    "Route the listed binaries through bash on Windows (comma-separated). Bypasses cmd.exe.",
  ),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
export const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
export const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to RU_FORK_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("RU_FORK_LOG_LEVEL").pipe(Config.withDefault("Info")),
  mode: Config.schema(RuntimeMode, "RU_FORK_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("RU_FORK_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("RU_FORK_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("RU_FORK_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  // ru-fork: env binding for --base-url. See baseUrlFlag.
  baseUrl: Config.string("RU_FORK_BASE_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("RU_FORK_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("RU_FORK_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("RU_FORK_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("RU_FORK_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

export interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  // ru-fork: see baseUrlFlag.
  readonly baseUrl: Option.Option<string>;
  readonly noBrowser: Option.Option<boolean>;
  // ru-fork: see noPreflightCheckFlag above.
  readonly noPreflightCheck: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  // ru-fork: see injectExtraPathsFlag.
  readonly injectExtraPaths: Option.Option<string>;
  // ru-fork: see windowsUseBashForFlag.
  readonly windowsUseBashFor: Option.Option<string>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
  // ru-fork: see baseUrlFlag. Auth subcommand doesn't take it, but
  // the shape is shared so we accept an optional Option.
  readonly baseUrl?: Option.Option<string>;
}

export const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  // ru-fork: see baseUrlFlag.
  baseUrl: baseUrlFlag,
  noBrowser: noBrowserFlag,
  // ru-fork: see noPreflightCheckFlag above.
  noPreflightCheck: noPreflightCheckFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  // ru-fork: see injectExtraPathsFlag / windowsUseBashForFlag.
  injectExtraPaths: injectExtraPathsFlag,
  windowsUseBashFor: windowsUseBashForFlag,
} as const;

export const authLocationFlags = sharedServerLocationFlags;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  // ru-fork: resolved once by the startup preflight (resolveStartupCli) and
  // threaded in — never re-derived here. configDir / cliJs / ourRoot all come
  // straight from the shared resolver, so install-time and launch-time agree
  // even in the bin split (config in {home}/.qwen, bin + our root elsewhere).
  cli: PreflightResolution,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      // ru-fork: see baseUrlFlag.
      baseUrl: flags.baseUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      // ru-fork: pass-through for the preflight skip flag.
      noPreflightCheck: flags.noPreflightCheck ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
      // ru-fork: spawn-policy flags; consumed by initSpawnPolicy,
      // not by resolveServerConfig (which is why they don't appear in
      // ServerConfigShape).
      injectExtraPaths: flags.injectExtraPaths ?? Option.none(),
      windowsUseBashFor: flags.windowsUseBashFor ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      // ru-fork: desktop mode binds loopback only, auto-issues sessions
      // for loopback source IPs, and pins the port — see local-startup/.
      () => DESKTOP_RUNTIME_MODE,
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === DESKTOP_RUNTIME_MODE) {
            // ru-fork: desktop mode pins to DEFAULT_PORT verbatim — no
            // findAvailablePort fallback. The actual port-availability check
            // (assertLocalPortAvailable) lives in cli/server.ts:runServerCommand
            // so non-listening commands (auth, project) that still call
            // resolveServerConfig don't trip it.
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    // ru-fork: resolve --base-url / RU_FORK_BASE_URL into the
    // normalized prefix that lives on ServerConfig (empty string when
    // unconfigured so the no-prefix path stays a hot path).
    const basePath = normalizeBasePath(
      Option.getOrUndefined(
        resolveOptionPrecedence(normalizedFlags.baseUrl, Option.fromUndefinedOr(env.baseUrl)),
      ),
    );
    // Default base dir is the resolver's ourRoot (the installed app folder,
    // bin-aware). --base-dir / RU_FORK_HOME / desktop bootstrap still override.
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.t3Home),
          Option.fromUndefinedOr(bootstrap?.t3Home),
        ),
      ) ?? cli.ourRoot,
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      // ru-fork: decoupled from mode. The precedence chain above already
      // returns Option.some(true) when startupPresentation === "headless" or
      // when --no-browser is set, so the default only fires for plain
      // foreground `ru-fork start` — which should always open a browser.
      // Daemon path passes --no-browser explicitly (daemonLauncher.ts) and
      // is unaffected.
      () => false,
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      // Only fabricate a default project when the user explicitly
      // pointed the server at a workspace via the positional `cwd`
      // arg. Without that signal, `process.cwd()` varies with the
      // launcher (pnpm/turbo can leave it at the monorepo root or
      // chdir into apps/server), which used to seed inconsistent
      // "default" projects across machines.
      () => mode === "web" && Option.isSome(normalizedFlags.cwd),
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      // ru-fork: mode-aware default — desktop pins to literal IPv4
      // loopback (DESKTOP_LOOPBACK_HOST). Avoids the Windows/Citrix
      // dual-stack bind roulette that caused the WebSocket "stuck" symptom
      // when the wildcard bind landed on IPv6-only. Web mode keeps Node's
      // wildcard. Users who want LAN exposure pass --host 0.0.0.0.
      () => (mode === DESKTOP_RUNTIME_MODE ? DESKTOP_LOOPBACK_HOST : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      mode,
      port,
      cwd,
      baseDir,
      // ru-fork: straight from the resolver — no dirname(baseDir) derivation.
      // RU_FORK_CLI_JS is a DEV-ONLY override: point it at the built fake ACP
      // server (tests/fixtures/fake-acp-server) to drive the real app against a
      // scripted wire failure for manual UI checks. Combine with RU_FORK_FAKE_ACP
      // (read by the fake itself) to pick which error to reproduce. See §9.5.
      cliJs: process.env["RU_FORK_CLI_JS"] ?? cli.cliJs,
      cliConfigDir: cli.configDir,
      ...derivedPaths,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      // ru-fork: see baseUrlFlag.
      basePath,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    // Auth subcommands read config too, so they need the same resolution. The
    // app is a CLI front-end — if the CLI can't be resolved, stop here as well.
    const cli = yield* resolveStartupCli;
    return yield* resolveServerConfig(
      {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      // ru-fork: auth subcommand doesn't accept --base-url; pass none.
      baseUrl: flags.baseUrl ?? Option.none(),
      noBrowser: Option.none(),
      // ru-fork: auth-only path; preflight not exercised here.
      noPreflightCheck: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      // ru-fork: auth subcommand doesn't spawn anything that
      // needs the policy, but CliServerFlags requires the fields.
      injectExtraPaths: Option.none(),
      windowsUseBashFor: Option.none(),
      },
      cliLogLevel,
      cli,
    );
  });

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
