// ru-code: Windows terminal foreground-subprocess inspection without PowerShell (seam:
// terminal/Manager.ts defaultSubprocessInspectorForPlatform). The legacy implementation spawns
// `powershell.exe -Command Get-CimInstance Win32_Process` EVERY SECOND per running terminal —
// the app's heaviest recurring spawn pattern, wasteful and fragile on some Windows setups. Methods
// (TERMINAL_INSPECT_WINDOWS_METHOD):
//   - "console-list": in-process `GetConsoleProcessList` via node-pty's SHIPPED native addon
//     (`prebuilds/win32-<arch>/conpty_console_list.node`) — ZERO child processes. It returns
//     the pids attached to the terminal's console: >1 pid ⇒ a foreground child is running.
//     No command NAME is available this way (label stays null — it has no UI consumer).
//   - "tasklist": console-list detection + ONE `tasklist.exe /fi "PID eq <child>"` spawn per
//     poll to resolve the child's image name (plain signed system exe, no script engine).
//   - "powershell": handled by the caller (legacy path, kept for comparison).
// This runs only while port scanning is enabled in Settings (see portScanGate.ts).

import * as NodeModule from "node:module";

import { TERMINAL_INSPECT_WINDOWS_METHOD } from "@ru-code/platform-compat/constants";
import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../../processRunner.ts";

/** Structurally matches Manager's TerminalSubprocessInspectResult. */
export interface WindowsInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

/** Neutral failure; the Manager seam wraps it into its own TerminalSubprocessCheckError. */
export class TerminalInspectCompatError extends Data.TaggedError("TerminalInspectCompatError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

type ConsoleListModule = {
  readonly getConsoleProcessList: (shellPid: number) => ReadonlyArray<number>;
};

let cachedConsoleListModule: ConsoleListModule | null | undefined;
// Set when the addon load fails, so the Effect path can logDebug it ONCE (the result is
// cached, so a per-poll log would spam). Cleared to undefined after it is emitted.
let consoleListLoadError: unknown;

/** Load node-pty's shipped console-list addon once; `null` = unavailable (cached). */
function loadConsoleListModule(architecture: string): ConsoleListModule | null {
  if (cachedConsoleListModule !== undefined) {
    return cachedConsoleListModule;
  }
  try {
    const requireFromHere = NodeModule.createRequire(import.meta.url);
    const nodePtyPackageJson = requireFromHere.resolve("node-pty/package.json");
    const nodePtyDir = nodePtyPackageJson.slice(0, -"package.json".length);
    const addonPath = `${nodePtyDir}prebuilds/win32-${architecture}/conpty_console_list.node`;
    cachedConsoleListModule = requireFromHere(addonPath) as ConsoleListModule;
  } catch (cause) {
    cachedConsoleListModule = null;
    consoleListLoadError = cause;
  }
  return cachedConsoleListModule;
}

const IDLE_RESULT = (terminalPid: number): WindowsInspectResult => ({
  hasRunningSubprocess: false,
  childCommand: null,
  processIds: [terminalPid],
});

function consoleListInspect(terminalPid: number, architecture: string): WindowsInspectResult {
  const consoleList = loadConsoleListModule(architecture);
  if (consoleList === null) {
    // Addon unavailable (unexpected — it ships with node-pty): report idle rather than fail
    // the poll every second. A terminal still works; only port→terminal attribution degrades.
    return IDLE_RESULT(terminalPid);
  }
  const attachedPids = consoleList.getConsoleProcessList(terminalPid);
  const processIds = attachedPids.includes(terminalPid)
    ? [...attachedPids]
    : [terminalPid, ...attachedPids];
  return {
    hasRunningSubprocess: processIds.length > 1,
    childCommand: null,
    processIds,
  };
}

/** First CSV field of a `tasklist /fo csv /nh` line, e.g. `"node.exe","123",…` → `node.exe`. */
export function parseTasklistImageName(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/u).find((line) => line.trim().startsWith('"'));
  if (firstLine === undefined) {
    return null;
  }
  const match = /^"([^"]+)"/u.exec(firstLine.trim());
  return match?.[1] ?? null;
}

const tasklistChildName = (childPid: number) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        command: "tasklist.exe",
        args: ["/fo", "csv", "/nh", "/fi", `PID eq ${childPid}`],
        timeout: "1500 millis",
        maxOutputBytes: 32_768,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalInspectCompatError({ reason: "tasklist child-name lookup failed", cause }),
        ),
      );
    if (result.code !== 0) {
      return null;
    }
    return parseTasklistImageName(result.stdout);
  });

/**
 * Inspect a Windows terminal's foreground child according to
 * TERMINAL_INSPECT_WINDOWS_METHOD ("powershell" is dispatched by the caller, never here).
 */
export const inspectWindowsSubprocessCompat = (
  terminalPid: number,
): Effect.Effect<WindowsInspectResult, TerminalInspectCompatError, ProcessRunner.ProcessRunner> =>
  Effect.gen(function* () {
    const architecture = yield* HostProcessArchitecture;
    const detection = yield* Effect.try({
      try: () => consoleListInspect(terminalPid, architecture),
      catch: (cause) =>
        new TerminalInspectCompatError({ reason: "GetConsoleProcessList failed", cause }),
    });
    // ru-code: one-time diagnostic — did the zero-spawn console-list path actually load, or
    // did it silently fall back to idle? (the result is cached, so this fires at most once).
    if (consoleListLoadError !== undefined) {
      const cause = consoleListLoadError;
      consoleListLoadError = undefined;
      yield* Effect.logDebug("[terminal-inspect] console-list addon unavailable, reporting idle", {
        cause,
      });
    }
    if (TERMINAL_INSPECT_WINDOWS_METHOD !== "tasklist" || !detection.hasRunningSubprocess) {
      return detection;
    }
    // "tasklist" mode adds the child's image name (one filtered tasklist call per poll).
    const childPid = detection.processIds.find((pid) => pid !== terminalPid);
    if (childPid === undefined) {
      return detection;
    }
    const childName = yield* tasklistChildName(childPid);
    return { ...detection, childCommand: childName };
  });
