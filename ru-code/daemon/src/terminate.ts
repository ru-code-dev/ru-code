// ru-code: terminate a daemon process by pid — the one shared kill routine used by
// both `stop` and the launcher's reclaim-our-stale path (DRY). SIGTERM lets the
// app's own teardown run (it kills its ACP children itself via the adapter
// finalizer); if it doesn't exit within the drain budget we escalate to SIGKILL.
// `force` skips straight to SIGKILL.
//
// PLATFORM TRUTH, stated because the drain language below reads as universal and is not:
// `process.kill(pid, "SIGTERM")` on Windows is mapped by Node to an unconditional
// `TerminateProcess` — there are no POSIX signals to deliver. So on Windows the server gets NO
// graceful window and its own teardown never runs; STOP_DRAIN_TIMEOUT_MS observes a process that
// is already gone. Nothing leaks either way — the ACP children are reaped by their journaled pids
// (KILL_BY_JOURNAL_PIDS, a pure `process.kill` per pid, which is exactly why that backend is the
// default) — but a clean drain is a POSIX-only property today. A real graceful stop on Windows
// needs a different mechanism (a control event or an IPC "please exit"), not a different constant.

import * as Effect from "effect/Effect";

import { isHostWindows } from "@t3tools/shared/hostProcess";

import { KILL_BY_JOURNAL_PIDS, KILL_CHILDREN, USE_TASK_KILL_FOR_WINDOWS } from "./constants.ts";
import { drainStoppingDaemon } from "./drain.ts";
import { reapJournaledChildren } from "./journalReap.ts";
import { isProcessAlive, signalProcess } from "./signal.ts";
import { killWindowsTree, sweepChildProcesses } from "./sweep.ts";

/** Returns true once the process is gone. */
export const terminateProcessGracefully = (
  pid: number,
  options?: { readonly force?: boolean },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (options?.force) {
      yield* signalProcess(pid, "SIGKILL");
      return yield* drainStoppingDaemon(pid);
    }

    yield* signalProcess(pid, "SIGTERM");
    if (yield* drainStoppingDaemon(pid)) {
      return true;
    }
    // Graceful window elapsed — force it.
    yield* signalProcess(pid, "SIGKILL");
    return yield* drainStoppingDaemon(pid);
  });

/**
 * Clean up ACP child processes after the server is down. Dispatch:
 * KILL_BY_JOURNAL_PIDS → reap the exact journaled pids (works on every
 * platform, pure syscalls); otherwise → the posix signature sweep (pkill).
 * When the server died gracefully it already killed its own children (and
 * emptied the journals), so both backends are survivors-only by construction.
 * `force` (from `stop --force`) makes the child kill hard (SIGKILL first pass).
 */
const cleanupChildren = (
  statePath: string,
  options?: { readonly force?: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!KILL_CHILDREN) {
      return;
    }
    if (KILL_BY_JOURNAL_PIDS) {
      yield* reapJournaledChildren(statePath, options);
      return;
    }
    yield* sweepChildProcesses(options);
  });

/**
 * Terminate a whole daemon instance — the **server** (by pid) AND its **child**
 * processes. Flow: graceful SIGTERM first (the app's own teardown kills its
 * children and empties the pid journals), drain up to STOP_DRAIN_TIMEOUT_MS,
 * SIGKILL only if the drain expired — then clean up surviving children per the
 * configured backend. Returns whether the **server pid** is confirmed gone, so
 * `stop` can report an honest success/failure instead of blindly claiming
 * "stopped".
 *
 * The signature backend keeps the old Windows tree-kill path (`taskkill /T`);
 * the journal backend never needs it — exact pids + `process.kill` work on
 * locked-down Windows where taskkill may be policy-blocked.
 */
export const terminateInstance = (params: {
  readonly pid: number;
  readonly force?: boolean;
  /** Path to `server-runtime.json` — the pid journals live in the same dir. */
  readonly statePath: string;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const force = params.force ? { force: true } : undefined;
    if (!KILL_BY_JOURNAL_PIDS && (yield* isHostWindows) && USE_TASK_KILL_FOR_WINDOWS) {
      // Signature backend on Windows: group-kill the tree per GROUP_KILL_METHOD
      // (children get their finalize window under the SIGTERM_* modes; --force
      // hard-kills immediately). The server must die regardless, so if the
      // polite pass left it alive, force its pid — then confirm.
      yield* killWindowsTree(params.pid, force);
      if (yield* isProcessAlive(params.pid)) {
        yield* signalProcess(params.pid, "SIGKILL");
      }
      return !(yield* isProcessAlive(params.pid));
    }
    const confirmedDead = yield* terminateProcessGracefully(params.pid, force);
    yield* cleanupChildren(params.statePath, force);
    return confirmedDead;
  });

/**
 * Pre-spawn orphan cleanup for the launcher's start-fresh path: no server is
 * running, so anything journaled (or signature-matched) is a crash leftover.
 */
export const reapOrphanedChildren = cleanupChildren;
