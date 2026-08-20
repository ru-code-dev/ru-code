// ru-code: `restart` = stop the running instance (server + its children) then
// start fresh. Pure composition of stopDaemon + launchDaemon (DRY).

import * as Effect from "effect/Effect";

import { type DaemonLaunchInput, launchDaemon } from "./launch.ts";
import { stopDaemon } from "./stop.ts";

export const restartDaemon = (input: DaemonLaunchInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Graceful-first (matches `stop`): SIGTERM lets the app flush + kill its own
    // children; the drain escalates to SIGKILL only if the server is wedged.
    yield* stopDaemon({ statePath: input.statePath, force: false });
    yield* launchDaemon(input);
  });
