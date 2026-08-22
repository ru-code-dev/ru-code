// ru-code: Windows browser-launch strategy (seam: process/externalLauncher.ts win32 + WSL
// branches). The legacy launch is `powershell.exe -EncodedCommand "Start <url>"` spawned with
// `detached: true` + all-`ignore` stdio — exactly the combination Node bug #51018 breaks on
// Windows (`spawn UNKNOWN`; PowerShell-specific: node.exe children are unaffected), and it was
// reproduced on a real Windows 10 machine. `explorer.exe <url>` opens the default browser with
// no PowerShell and no fragile option combo. EXTERNAL_OPEN_WINDOWS switches the behaviours.

import { EXTERNAL_OPEN_WINDOWS } from "@ru-code/platform-compat/constants";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";

/** Structurally matches externalLauncher's internal ProcessLaunch. */
export interface WindowsBrowserLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

/**
 * Build the Windows (or Windows-from-WSL) browser launch. `cmd-start` mode spawns
 * `cmd.exe /d /s /c start "" <url>` — cmd's `start` builtin ShellExecutes the FULL url
 * (explorer.exe drops the `#token=…` pairing fragment), non-detached (start hands off and
 * exits immediately; the caller already `unref`s), stdio ignored (safe: #51018 is
 * PS-specific). `explorer` mode is the previous strategy, kept for comparison.
 * `powershell` mode returns the caller-supplied legacy launch untouched.
 */
export function buildWindowsBrowserLaunchCompat(
  target: string,
  legacyPowerShellLaunch: () => WindowsBrowserLaunch,
): WindowsBrowserLaunch {
  if (EXTERNAL_OPEN_WINDOWS === "powershell") {
    return legacyPowerShellLaunch();
  }
  const hiddenLaunchOptions = {
    detached: false,
    shell: false,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  } as const;
  if (EXTERNAL_OPEN_WINDOWS === "explorer") {
    return {
      // Works from WSL too: the Windows interop resolves `explorer.exe` via the appended PATH.
      command: "explorer.exe",
      args: [target],
      options: hiddenLaunchOptions,
    };
  }
  return {
    // Works from WSL too: the Windows interop resolves `cmd.exe` via the appended PATH.
    // The empty "" arg is start's window-title slot — without it a quoted url would be
    // consumed as the title instead of the target.
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", target],
    options: hiddenLaunchOptions,
  };
}
