// ru-code: second-Ctrl-C escape hatch. The Effect runtime (runMain) interrupts
// the main fiber on the FIRST SIGINT/SIGTERM so the app's own teardown runs —
// the adapter finalizer kills every ACP child correctly. But repeated signals
// are a no-op there (the handler just re-interrupts the same fiber, and Node's
// default die-on-SIGINT is suppressed while a listener is installed) — a hung
// finalizer would trap the terminal with no way out. This installs a counter:
// the first signal passes through untouched (graceful teardown), the SECOND
// hard-exits with the conventional 130. Orphans from that hard exit are reaped
// by the journal reaper on the next launch.

const HARD_EXIT_CODE = 130; // 128 + SIGINT — the conventional "killed by Ctrl-C"

/** Install the second-signal hard exit. Call once, before the server starts. */
export const installSecondSignalHardExit = (): void => {
  let signalsSeen = 0;
  const onSignal = (): void => {
    signalsSeen += 1;
    if (signalsSeen >= 2) {
      process.exit(HARD_EXIT_CODE);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
};
