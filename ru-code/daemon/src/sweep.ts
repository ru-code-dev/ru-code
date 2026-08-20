// @effect-diagnostics nodeBuiltinImport:off
// ru-code: sweep the child processes (qwen --acp, …) that outlive a hard-killed
// server. posix → `pkill -f <signature>` (matches by command line, so parent/
// group/session are irrelevant). Windows → full-path `taskkill.exe /T /PID`
// (kills the tree). The SIGNAL + grace behaviour is governed by GROUP_KILL_METHOD /
// SIGTERM_GRACE_MS: a hard SIGKILL, a polite SIGTERM then SIGKILL after a grace, or
// a polite SIGTERM with no wait (children finalize on their own). Best-effort — a
// missing pkill/taskkill or a no-match is fine.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { isHostWindows } from "@t3tools/shared/hostProcess";

import {
  GROUP_KILL_METHOD,
  KILL_CHILDREN,
  PROCESSES_SIGNATURES,
  SIGTERM_GRACE_MS,
  USE_TASK_KILL_FOR_WINDOWS,
} from "./constants.ts";

const SWEEP_TIMEOUT_MS = 4_000;

/** Full path to taskkill.exe — spawn exes by full path on Windows (PATHEXT is not searched). */
const taskkillExe = (): string =>
  NodePath.join(
    process.env.SystemRoot ?? process.env.windir ?? String.raw`C:\Windows`,
    "System32",
    "taskkill.exe",
  );

/** Run a command, ignore its result — resolves whether it succeeds, fails, or is absent. */
const runQuiet = (command: string, args: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { windowsHide: true, timeout: SWEEP_TIMEOUT_MS },
      () => resume(Effect.void),
    );
  });

/** posix: signal every process whose command line matches one of our signatures. */
const pkillSignatures = (signal: "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
  Effect.gen(function* () {
    const flag = signal === "SIGKILL" ? "-KILL" : "-TERM";
    for (const signature of PROCESSES_SIGNATURES) {
      yield* runQuiet("pkill", [flag, "-f", signature]);
    }
  });

/** Windows: taskkill the pid's tree — force (`/F`) or polite WM_CLOSE (no `/F`). */
const taskkillTree = (pid: number, force: boolean): Effect.Effect<void> =>
  runQuiet(taskkillExe(), [...(force ? ["/F"] : []), "/T", "/PID", String(pid)]);

/**
 * posix: group-kill the child signatures per GROUP_KILL_METHOD — or hard
 * (SIGKILL) when the caller forces it (`stop --force`). No-op on Windows / when
 * disabled. SIGTERM_WITH_GRACE waits then escalates; SIGTERM_NO_WAIT fires once.
 */
export const sweepChildProcesses = (options?: { readonly force?: boolean }): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!KILL_CHILDREN || (yield* isHostWindows)) {
      return;
    }
    if (options?.force === true || GROUP_KILL_METHOD === "SIGKILL") {
      yield* pkillSignatures("SIGKILL");
      return;
    }
    yield* pkillSignatures("SIGTERM");
    if (GROUP_KILL_METHOD === "SIGTERM_WITH_GRACE") {
      yield* Effect.sleep(Duration.millis(SIGTERM_GRACE_MS));
      yield* pkillSignatures("SIGKILL");
    }
    // SIGTERM_NO_WAIT: polite terminate already sent — fire-and-forget.
  });

/**
 * Windows: group-kill the pid's tree per GROUP_KILL_METHOD — hard (`/F`)
 * immediately when the caller forces it. No-op elsewhere / when disabled.
 * Callers that need the server itself confirmed dead force + re-probe its pid
 * separately (see terminate.ts).
 */
export const killWindowsTree = (
  pid: number,
  options?: { readonly force?: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* isHostWindows) || !KILL_CHILDREN || !USE_TASK_KILL_FOR_WINDOWS) {
      return;
    }
    if (options?.force === true || GROUP_KILL_METHOD === "SIGKILL") {
      yield* taskkillTree(pid, true);
      return;
    }
    yield* taskkillTree(pid, false);
    if (GROUP_KILL_METHOD === "SIGTERM_WITH_GRACE") {
      yield* Effect.sleep(Duration.millis(SIGTERM_GRACE_MS));
      yield* taskkillTree(pid, true);
    }
    // SIGTERM_NO_WAIT: polite tree close already sent — fire-and-forget.
  });
