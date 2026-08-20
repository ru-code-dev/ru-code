// ru-code: single-instance guard for every NON-child server start (`serve`,
// `--foreground`, desktop). The daemon's own launch path has its reuse/reclaim
// gate, but those paths bypass it — and in web mode the app auto-picks a free
// port, so a second server would happily start NEXT TO the daemon, clobber the
// shared `server-runtime.json`, and interleave the same pid journals. This guard
// makes that impossible: if the recorded instance is alive AND listening, the
// start is refused with a localized message. The daemon child itself is exempt
// (env marker) — at its boot the state file only holds the old, dead instance.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { APP_HOME_SLUG } from "@ru-code/branding";
import { L } from "@ru-code/localization";

import { DAEMON_CHILD_ENV, DEFAULT_DAEMON_HOST } from "./constants.ts";
import { isPortInUse } from "./net.ts";
import { failWith } from "./report.ts";
import { readRuntimeState } from "./runtimeState.ts";
import { isProcessAlive } from "./signal.ts";

export interface RunningInstanceConflict {
  readonly pid: number;
  readonly port: number;
}

/**
 * The testable core: `Some(conflict)` when the state file records an instance
 * that is alive AND accepting connections; `None` otherwise (no state, dead
 * pid, or not listening — a stale record never blocks a start).
 */
export const checkSingleInstance = (
  statePath: string,
): Effect.Effect<Option.Option<RunningInstanceConflict>> =>
  Effect.gen(function* () {
    if (process.env[DAEMON_CHILD_ENV] === "1") {
      return Option.none(); // the spawned daemon child IS the legitimate instance
    }
    const state = yield* readRuntimeState(statePath);
    if (Option.isNone(state)) {
      return Option.none();
    }
    if (!(yield* isProcessAlive(state.value.pid))) {
      return Option.none();
    }
    const host = state.value.host ?? DEFAULT_DAEMON_HOST;
    if (!(yield* isPortInUse(host, state.value.port))) {
      return Option.none();
    }
    return Option.some({ pid: state.value.pid, port: state.value.port });
  });

/** Refuse the start (localized red notice + non-zero exit) on a live conflict. */
export const ensureSingleInstance = (statePath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const conflict = yield* checkSingleInstance(statePath);
    if (Option.isNone(conflict)) {
      return;
    }
    const { pid, port } = conflict.value;
    return yield* failWith(
      L(
        `Already running (pid ${pid}, port ${port}). Stop it first: ${APP_HOME_SLUG} stop`,
        `Уже запущен (pid ${pid}, порт ${port}). Сначала остановите: ${APP_HOME_SLUG} stop`,
      ),
    );
  });
