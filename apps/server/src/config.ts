/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";

import type { AbortMethod } from "@t3tools/contracts";

import {
  CLI_BINARY_NAME as BRAND_CLI_BINARY_NAME,
  CLI_CONFIG_DIRNAME,
  CLI_DISPLAY_NAME,
  SLASH_COMMAND_NOTIFICATION_METHODS as BRAND_SLASH_COMMAND_NOTIFICATION_METHODS,
} from "@ru-fork/branding";
// ru-fork: unified to 7777 across platforms so desktop mode can bind a
// stable loopback port everywhere. See `ru-fork/local-startup/` for the
// policy (port-80 on macOS was the only reason for the platform carve-out;
// once defaults switch to desktop+loopback the carve-out is no longer needed).
export const DEFAULT_PORT = 7777;

/**
 * CLI_BINARY_NAME — the binary spawned for ACP sessions, status probes,
 * and text generation. Re-exported from `@ru-fork/branding`, the single
 * source of truth for brand/vendor values.
 */
export const CLI_BINARY_NAME = BRAND_CLI_BINARY_NAME;

/**
 * CLI_NAME — human-readable name of the underlying CLI, used in user-facing
 * status/error messages, model picker labels, and settings descriptions.
 * Append " CLI" inline when the surrounding sentence specifically refers to
 * the CLI binary (e.g. health-check messages). Re-exported from
 * `@ru-fork/branding`.
 */
export const CLI_NAME = CLI_DISPLAY_NAME;

/**
 * CLI_AUTH_METHOD_ID — the ACP `authenticate` methodId used to select a
 * credential flow on the spawned CLI. Matches the auth method the CLI
 * advertises during ACP `initialize`.
 */
export const CLI_AUTH_METHOD_ID = "openai";

/**
 * SLASH_COMMAND_NOTIFICATION_METHODS — ACP vendor-extension notification
 * methods carrying slash-command progress/result text. Re-exported from
 * `@ru-fork/branding` where the vendor namespaces are centralized.
 */
export const SLASH_COMMAND_NOTIFICATION_METHODS: readonly string[] =
  BRAND_SLASH_COMMAND_NOTIFICATION_METHODS;

/**
 * ACP_SERVER_NO_SSL — when true, the spawned ACP child runs with
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling TLS certificate
 * validation for all HTTPS calls inside that Node process. Set true
 * to work around self-signed CA chains that break tools
 * like WebFetch from inside CLI.
 */
export const ACP_SERVER_NO_SSL = true;

/**
 * STOP_BUTTON_METHOD — what the Stop button (`thread.turn.interrupt`)
 * does. "end-force" because CLI builds we ship against can ignore
 * both `acp.cancel` and SIGTERM, hanging `Scope.close` indefinitely
 * and gridlocking the (single-fiber) reactor worker. SIGKILL is
 * kernel-unmaskable and cannot hang.
 *
 * Conversation context is NOT lost: the persisted binding directory
 * keeps the resumeCursor and the next `startSession` calls CLI
 * `session/load` to restore the on-disk transcript.
 *
 * Flip to "cancel-turn" once we trust the active agent to honour ACP
 * `session/cancel` cleanly — the Stop button will then end only the
 * current turn and the user can keep chatting on the same session.
 */
export const STOP_BUTTON_METHOD: AbortMethod = "end-force";

/**
 * MODE_CHANGE_METHOD — how the implicit session restart on
 * runtime-mode/cwd/instance change tears down the previous session.
 * "end-force" because SIGKILL is unmaskable and cannot hang.
 *
 * Future: flip to "reset-session" once that's implemented (avoids
 * re-spawning the CLI child every mode change).
 */
export const MODE_CHANGE_METHOD: AbortMethod = "end-force";

/**
 * MAINTENANCE_METHOD — used by call sites that tear down a session
 * for non-user-triggered reasons: `stopSession` (thread deletion or
 * `thread.session.stop`), `stopAll` (app-level cleanup), and the
 * adapter finalizer (process shutdown). "end-force" for the same
 * hang-resistance reason as STOP_BUTTON_METHOD: a stuck child must
 * not block teardown.
 */
export const MAINTENANCE_METHOD: AbortMethod = "end-force";

/**
 * CONTEXT_WINDOW_TOKENS — total context window size advertised to the
 * UI for the current CLI binary. Hardcoded rather than extracted from
 * the ACP session response: the CLI CLI reports a model-config limit
 * that doesn't match what the chat actually has available, so the UI
 * counter ended up showing the wrong denominator. Update this when
 * switching to a CLI/model with a different effective window.
 */
export const CONTEXT_WINDOW_TOKENS = 252_000;

// ru-fork: name of the directory the underlying CLI (CLI) uses for
// per-project + per-user state. Skills live in <CLI_FOLDER>/skills/.
// Global skills root is auto-derived as `<dirname(baseDir)>/<CLI_FOLDER>/skills`
export const CLI_FOLDER = CLI_CONFIG_DIRNAME;

// ru-fork: enable fs.watch on the skills roots. Off by default —
// large project trees + recursive descent are heavy and most skill
// changes happen through editor saves the user will refresh manually
// via /refresh-skills. Composer-mount + /refresh-skills cover the
// real-world cases.
export const SKILLS_FS_WATCH_RECURSIVE = false;

// ru-fork: max length of the `detail` string stored on each
// `OrchestrationThreadActivity.payload` and persisted into the SQLite
// `projection_thread_activities.payload_json` column. Used by
// `truncateDetail` in `orchestration/Layers/ProviderRuntimeIngestion.ts`.
// Kept at 180 (the historical hardcoded default) on purpose: not every
// client renderer wraps/clamps this string, so bumping the cap before
// the UI is fixed causes real overflow regressions (long shell commands
// blow out cards / sidebars). Bump to ~600 once the timeline tooltip
// uses a client-side inline slice and the other consumers are audited;
// the original investigation lives in `instrumental/changes/...` if
// you need the rationale. Pathological multi-KB blobs (MCP tool output
// dumped into `description`) are also bounded by this cap.
export const ACTIVITY_DETAIL_MAX_CHARS = 180;

export const RuntimeMode = Schema.Literals(["web", "desktop"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const StartupPresentation = Schema.Literals(["browser", "headless"]);
export type StartupPresentation = typeof StartupPresentation.Type;

/**
 * ServerDerivedPaths - Derived paths from the base directory.
 */
export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly providerStatusCacheDir: string;
  // ru-fork: scanner-owned skills cache (filesystem-driven, replaces the
  // dead `_meta.availableSkills` wire path).
  readonly skillsCachePath: string;
  // ru-fork: scanner-owned subagents cache; sibling of skills.json.
  readonly subagentsCachePath: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly environmentIdPath: string;
  readonly serverRuntimeStatePath: string;
  readonly secretsDir: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly logLevel: LogLevel.LogLevel;
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly baseDir: string;
  // ru-fork: resolved by the startup preflight (shared resolver, common-preflight.md).
  // cliJs   — absolute path to the underlying CLI's cli.js; every CLI spawn runs
  //           `node <cliJs> …` directly (see ru-fork/spawn/policy.ts buildCliSpawn).
  // cliConfigDir — the CLI's config dir ({home}/$CLI_DIR); skills/agents read here.
  readonly cliJs: string;
  readonly cliConfigDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly startupPresentation: StartupPresentation;
  readonly desktopBootstrapToken: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
  // ru-fork: normalized path prefix for reverse-proxy mounts;
  // empty string when none. Sourced from --base-url / RU_FORK_BASE_URL
  // through `resolveServerConfig`.
  readonly basePath: string;
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
  devUrl: ServerConfigShape["devUrl"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, devUrl !== undefined ? "dev" : "userdata");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(baseDir, "caches");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    providerStatusCacheDir,
    // ru-fork: sibling of CLI.json under caches/ — single machine-managed file.
    skillsCachePath: join(providerStatusCacheDir, "skills.json"),
    // ru-fork: sibling of skills.json; same on-disk codec shape.
    subagentsCachePath: join(providerStatusCacheDir, "subagents.json"),
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    environmentIdPath: join(stateDir, "environment-id"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    secretsDir: join(stateDir, "secrets"),
  };
});

export const ensureServerDirectories = Effect.fn(function* (derivedPaths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.all(
    [
      fs.makeDirectory(derivedPaths.stateDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.logsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.providerLogsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.terminalLogsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.attachmentsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.worktreesDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.keybindingsConfigPath), { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true }),
      fs.makeDirectory(derivedPaths.providerStatusCacheDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.serverRuntimeStatePath), { recursive: true }),
    ],
    { concurrency: "unbounded" },
  );
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "t3/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, baseDirOrPrefix: string | { prefix: string }) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const devUrl = undefined;

        const fs = yield* FileSystem.FileSystem;
        const baseDir =
          typeof baseDirOrPrefix === "string"
            ? baseDirOrPrefix
            : yield* fs.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix });
        const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
        yield* ensureServerDirectories(derivedPaths);
        const path = yield* Path.Path;

        return {
          logLevel: "Error",
          cwd,
          baseDir,
          // ru-fork: tests don't spawn the real CLI; keep the legacy
          // dirname(baseDir)/$CLI_DIR layout so skill/agent scanner tests resolve
          // the same roots as before.
          cliJs: path.join(baseDir, "cli.js"),
          cliConfigDir: path.join(path.dirname(baseDir), CLI_FOLDER),
          ...derivedPaths,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          port: 0,
          host: undefined,
          desktopBootstrapToken: undefined,
          staticDir: undefined,
          devUrl,
          noBrowser: false,
          startupPresentation: "browser",
          // ru-fork: tests run without a configured base-path.
          basePath: "",
        } satisfies ServerConfigShape;
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
