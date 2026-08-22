/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
// ru-code: Windows browser-launch strategy — `cmd /c start` (ShellExecute keeps the #token
// fragment; explorer.exe drops it) instead of the Node-#51018-broken powershell+detached+ignore
// combo (EXTERNAL_OPEN_WINDOWS switches; body in the ru-code zone).
import { buildWindowsBrowserLaunchCompat } from "../ru-code/platform-compat/externalOpenWindows.ts";
// ru-code: background-scanned + cached editor availability (USE_NON_BLOCKIN_EDITORS_SCAN).
import { makeAvailableEditorsCompat } from "../ru-code/process/availableEditors.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
// ru-code: the browser opener tries a chain of candidates, so it needs per-attempt results.
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// ==============================
// Definitions
// ==============================

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@t3tools/contracts";
export type { LaunchEditorInput };
interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const BrowserLaunchEnvConfig = Config.all({
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.string("WSL_INTEROP").pipe(Config.option),
  SSH_CONNECTION: Config.string("SSH_CONNECTION").pipe(Config.option),
  SSH_TTY: Config.string("SSH_TTY").pipe(Config.option),
  container: Config.string("container").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readBrowserLaunchEnv = BrowserLaunchEnvConfig.pipe(Effect.orElseSucceed(() => ({})));
const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

const resolveAvailableCommand = Effect.fn("externalLauncher.resolveAvailableCommand")(function* (
  commands: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  for (const command of commands) {
    if (yield* isCommandAvailable(command, { env })) {
      return Option.some(command);
    }
  }
  return Option.none();
});

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function escapePowerShellStringLiteral(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv = {}): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function resolveWslPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

function shouldUseWindowsBrowserFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

function resolveWindowsBrowserLaunch(target: string, command: string): ProcessLaunch {
  const encodedCommand = encodeUtf16LeBase64(
    `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(target)}`,
  );
  return {
    command,
    args: [...POWERSHELL_ARGUMENTS_PREFIX, encodedCommand],
    options: {
      detached: true,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function buildBrowserLaunch(
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    // ru-code: explorer.exe by default (Node #51018 breaks the PS launch below).
    return buildWindowsBrowserLaunchCompat(target, () =>
      resolveWindowsBrowserLaunch(target, resolvePowerShellPath(env)),
    );
  }

  if (shouldUseWindowsBrowserFromWsl(platform, env)) {
    // ru-code: same compat switch for the WSL→Windows browser path.
    return buildWindowsBrowserLaunchCompat(target, () =>
      resolveWindowsBrowserLaunch(target, resolveWslPowerShellPath()),
    );
  }

  return {
    command: "xdg-open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      const command = fileManagerCommandForPlatform(platform);
      if (yield* isCommandAvailable(command, { env })) {
        available.push(editor.id);
      }
      continue;
    }

    const command = yield* resolveAvailableCommand(editor.commands, env);
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
});

const resolveBrowserLaunch = Effect.fn("externalLauncher.resolveBrowserLaunch")(function* (
  target: string,
) {
  const platform = yield* HostProcessPlatform;
  const env = yield* readBrowserLaunchEnv;
  return buildBrowserLaunch(target, platform, env);
});

const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  return yield* buildAvailableEditors(platform, env);
});

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /** Launch a URL target in the default browser. */
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    /**
     * Launch a workspace path in a selected editor integration.
     *
     * Launches the editor as a detached process so server startup is not blocked.
     */
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("t3/process/externalLauncher") {}

// ==============================
// Implementations
// ==============================

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      yield* resolveAvailableCommand(editorDef.commands, env),
      () => editorDef.commands[0],
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command: fileManagerCommandForPlatform(platform),
    args: [input.cwd],
  };
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

// ru-code: on Linux there is no single reliable opener. `xdg-open` is missing on minimal installs
// and is a shell→D-Bus chain that quietly does nothing without a desktop session; `$BROWSER` is the
// user's explicit choice and must win; `gio open` covers GNOME/portal setups where xdg-utils is
// absent. One attempt that silently loses is exactly why "the browser never opened after install"
// was unexplainable — so try them in order and report which ones were tried.
export const linuxBrowserLaunches = (
  target: string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<ProcessLaunch> => {
  const explicit =
    typeof env["BROWSER"] === "string" && env["BROWSER"].trim() !== ""
      ? [env["BROWSER"].trim()]
      : [];
  return [...explicit, "xdg-open", "gio"].map((command) => ({
    command,
    args: command === "gio" ? ["open", target] : [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  }));
};

const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const primary = yield* resolveBrowserLaunch(target);
  // ru-code: the fallback chain applies exactly where the primary resolver lands on xdg-open —
  // macOS `open` and the Windows/WSL strategies hand off to a system service and need no chain.
  const env = yield* readBrowserLaunchEnv;
  const candidates = primary.command === "xdg-open" ? linuxBrowserLaunches(target, env) : [primary];

  // Availability decides the ORDER, not whether we try at all: a missing binary surfaces as an
  // async spawn error that a fire-and-forget launch never sees, so probing is the only way the
  // chain can advance. When nothing is probeable (no PATH to scan), fall back to the platform
  // default and let it speak for itself — best-effort, exactly as before the chain existed.
  const available: Array<ProcessLaunch> = [];
  for (const launch of candidates) {
    if (yield* isCommandAvailable(launch.command, { env })) available.push(launch);
  }
  const attempts = available.length > 0 ? available : [candidates[0] ?? primary];

  let lastError: ExternalLauncherError | null = null;
  for (const launch of attempts) {
    const attempt = yield* launchAndUnref(
      launch,
      (cause) =>
        new ExternalLauncherBrowserSpawnError({
          target,
          command: launch.command,
          args: launch.args,
          cause,
        }),
    ).pipe(Effect.result);
    if (Result.isSuccess(attempt)) return;
    lastError = attempt.failure;
  }
  return yield* (
    lastError ??
      new ExternalLauncherBrowserSpawnError({
        target,
        command: primary.command,
        args: primary.args,
        cause: new Error("no browser opener available"),
      })
  );
});

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, { env });
  yield* launchAndUnref(
    {
      command: spawnCommand.command,
      args: spawnCommand.args,
      options: {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: spawnCommand.command,
        args: spawnCommand.args,
        cause,
      }),
  );
});

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  // ru-code: the editor list is served from a background-scanned cache instead of walking PATH
  // inside `server.getConfig` (the client's connection gate). USE_NON_BLOCKIN_EDITORS_SCAN
  // switches the behaviours; body in the ru-code zone.
  const availableEditors = yield* provideCommandResolutionServices(
    makeAvailableEditorsCompat({
      legacy: () => provideCommandResolutionServices(resolveAvailableEditors()),
    }),
  );

  return ExternalLauncher.of({
    resolveAvailableEditors: () => availableEditors.resolve,
    launchBrowser: (target) =>
      // ru-code: the opener chain resolves command availability, so it needs the same
      // FileSystem/Path services the editor path already gets.
      provideCommandResolutionServices(
        launchBrowser(target).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), (launch) =>
          launchEditorProcess(launch).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
