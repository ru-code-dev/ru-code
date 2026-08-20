// ru-code: Windows-safe terminal teardown (seams: terminal/NodePtyAdapter.ts kill +
// terminal/Manager.ts runKillEscalation). node-pty's WindowsTerminal.kill THROWS
// ("Signals not supported on windows.") for ANY signal argument, so upstream's
// kill("SIGTERM")/kill("SIGKILL") never terminates anything on Windows — every terminal
// stop/restart leaked the shell + its conhost pair AND logged a warning. With
// TERMINAL_WINDOWS_KILL_COMPAT on:
//   - kill() is called WITHOUT a signal on win32 (ConPTY kill terminates the process tree —
//     the same approach VS Code uses); POSIX passes the signal through unchanged;
//   - the graceful→forceful escalation is corrected: a THROWN graceful kill still attempts
//     the force-kill step (upstream silently gave up), and on win32 the force-kill step is
//     SKIPPED after a successful kill() — ConPTY kill is already forceful, and a second
//     kill() on the closed pty would throw a spurious warning every teardown.

import { TERMINAL_WINDOWS_KILL_COMPAT } from "@ru-code/platform-compat/constants";

/** Signal-safe kill: bare `kill()` on win32 (compat on), pass-through otherwise. */
export function killPtyProcessCompat(
  kill: (signal?: string) => void,
  signal: string | undefined,
  platform: NodeJS.Platform,
): void {
  if (TERMINAL_WINDOWS_KILL_COMPAT && platform === "win32") {
    kill();
    return;
  }
  kill(signal);
}

/** After a FAILED graceful kill: still try the force-kill step? (upstream: never). */
export function shouldForceKillAfterFailedGracefulKill(): boolean {
  return TERMINAL_WINDOWS_KILL_COMPAT;
}

/** After a SUCCESSFUL graceful kill on win32: skip force-kill (ConPTY kill is already hard). */
export function shouldSkipForceKillAfterGracefulKill(platform: NodeJS.Platform): boolean {
  return TERMINAL_WINDOWS_KILL_COMPAT && platform === "win32";
}
