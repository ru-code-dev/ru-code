// ru-code: poll a stopping daemon's pid until it exits or the drain budget is
// spent. Shared by the launcher (reclaiming our own stale instance) and `stop`.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { STOP_DRAIN_TIMEOUT_MS, STOP_POLL_INTERVAL_MS } from "./constants.ts";
import { isProcessAlive } from "./signal.ts";

/** Returns true once the pid is gone; false if it's still alive after the budget. */
export const drainStoppingDaemon = (pid: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const maxPolls = Math.ceil(STOP_DRAIN_TIMEOUT_MS / STOP_POLL_INTERVAL_MS);
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (!(yield* isProcessAlive(pid))) {
        return true;
      }
      yield* Effect.sleep(Duration.millis(STOP_POLL_INTERVAL_MS));
    }
    return !(yield* isProcessAlive(pid));
  });
