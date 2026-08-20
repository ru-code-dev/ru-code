// ru-code: inspect whatever daemon the state file records — is its pid alive, and
// is it actually accepting connections? The launcher uses this to decide between
// reuse (healthy), reclaim (alive but not listening), and spawn (nothing there).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isPortInUse } from "./net.ts";
import { type DaemonRuntimeState, readRuntimeState } from "./runtimeState.ts";
import { isProcessAlive } from "./signal.ts";

export interface ExistingDaemon {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  /** Plain origin (no token) — shown on reuse, where the persisted token is stale. */
  readonly origin: string;
  /** ISO start time — for the "running for" uptime line. */
  readonly startedAt: string;
  readonly alive: boolean;
  readonly listening: boolean;
}

const stateUrl = (state: DaemonRuntimeState): string => state.pairingUrl ?? state.origin;

export const inspectExistingDaemon = (
  statePath: string,
  host: string,
): Effect.Effect<Option.Option<ExistingDaemon>> =>
  Effect.gen(function* () {
    const state = yield* readRuntimeState(statePath);
    if (Option.isNone(state)) {
      return Option.none();
    }
    const alive = yield* isProcessAlive(state.value.pid);
    const listening = alive ? yield* isPortInUse(host, state.value.port) : false;
    return Option.some({
      pid: state.value.pid,
      port: state.value.port,
      url: stateUrl(state.value),
      origin: state.value.origin,
      startedAt: state.value.startedAt,
      alive,
      listening,
    });
  });
