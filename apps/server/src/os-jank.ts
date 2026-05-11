import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { APP_HOME_DIRNAME } from "@t3tools/contracts";
import {
  readPathFromLoginShell,
  // ru-fork: Windows-side env probing kept around (commented) in
  // case we ever reintroduce non-git-bash Windows support. See comment
  // block inside fixPath() and shell.ts. Re-enable both together.
  // readEnvironmentFromWindowsShell,
  // resolveWindowsEnvironment,
  // type CommandAvailabilityOptions,
  // type WindowsShellEnvironmentReader,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
} from "@t3tools/shared/shell";

// ru-fork: kept commented for symmetry with the Windows branch below.
// type WindowsCommandAvailabilityChecker = (
//   command: string,
//   options?: CommandAvailabilityOptions,
// ) => boolean;

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    // ru-fork: Windows-only knobs commented out alongside the
    // Windows branch in the body. Re-enable both together.
    // readWindowsEnvironment?: WindowsShellEnvironmentReader;
    // isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  const readPath = options.readPath ?? readPathFromLoginShell;

  try {
    // ru-fork: Windows PATH hydration disabled. The git-bash-only
    // policy means ru-fork is always launched from a bash session
    // that already has the right inherited PATH; we don't need to
    // shell out to PowerShell to widen it. The previous branch printed
    // stderr noise on ConstrainedLanguage machines without delivering
    // value. Code preserved below for the case we ever need to bring
    // non-git-bash launch contexts back; re-enable by uncommenting AND
    // re-enabling the matching imports/types/options at the top.
    //
    // if (platform === "win32") {
    //   const repairedEnvironment = resolveWindowsEnvironment(env, {
    //     readEnvironment: options.readWindowsEnvironment ?? readEnvironmentFromWindowsShell,
    //     ...(options.isWindowsCommandAvailable
    //       ? { commandAvailable: options.isWindowsCommandAvailable }
    //       : {}),
    //   });
    //   for (const [key, value] of Object.entries(repairedEnvironment)) {
    //     if (value !== undefined) {
    //       env[key] = value;
    //     }
    //   }
    //   return;
    // }
    if (platform === "win32") return;

    if (platform !== "darwin" && platform !== "linux") return;

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        shellPath = readPath(shell);
      } catch (error) {
        logWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) {
        break;
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellPath
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), APP_HOME_DIRNAME);
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
