// ru-code: process liveness + signalling via the global `process` (a syscall
// wrapper — no `taskkill`, no shell, so it works on locked-down Windows too).
// Uses the `process` global, not a node import, so no diagnostics directive needed.

import * as Effect from "effect/Effect";

const errorCode = (cause: unknown): string | undefined =>
  (cause as NodeJS.ErrnoException | undefined)?.code;

/** True if `pid` names a live process. Signal `0` probes without killing. */
export const isProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // ESRCH = gone; EPERM = alive but not ours (still counts as alive).
      return errorCode(cause) === "EPERM";
    }
  });

/** Deliver `signal` to `pid`; a missing process is treated as success. */
export const signalProcess = (pid: number, signal: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
    } catch (cause) {
      if (errorCode(cause) !== "ESRCH") {
        // EPERM / unexpected — callers drain on liveness, not on this result.
      }
    }
  });
