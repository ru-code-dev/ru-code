// ru-code: the `update-relaunch` hidden CLI command — the ONLY process between the old server and
// the new one. Spawned DETACHED by the install run right before the old server exits; it reuses
// the daemon package's shipped primitives unchanged (stopDaemon → graceful SIGTERM + drain;
// launchDaemon → the tested cross-platform spawn) with ONE addition between them: the pinned-port
// gate. The relaunched child must bind EXACTLY the old port — the SW updating page polls that
// origin and a drifted port is invisible to the browser (user decision: 3 attempts, 30 s apart,
// then STOP; no drift, ever). A port that stays busy is an ENVIRONMENTAL failure, journaled as
// `port-busy` (never a version failure), and the SW page's 2-minute window lands the user on the
// manual-restart screen. This process lives seconds and exits unconditionally — correctness never
// depends on it (a manual launch converges through the same wrapper + pointer).

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// ru-code: the pinned-port retry budget is a branding tunable — see
// ru-code/branding/src/auto-update.ts.
import { UPDATE_PIN_ATTEMPTS, UPDATE_PIN_RETRY_DELAY_MS } from "@ru-code/branding";
import * as Daemon from "@ru-code/daemon";

/**
 * Documented, default-off test seam. `RU_CODE_UPDATE_TEST_PIN_MS`, when set to a
 * positive integer, shrinks the pinned-port retry delay (default 30 000 ms × 3 =
 * up to ~65 s) so the port-busy break-matrix case runs in seconds. Unset/invalid ⇒
 * the production UPDATE_PIN_RETRY_DELAY_MS is used unchanged. Read once per relaunch.
 */
export const PIN_MS_TEST_ENV = "RU_CODE_UPDATE_TEST_PIN_MS";

const testPinDelayMs = (): number => {
  const raw = process.env[PIN_MS_TEST_ENV];
  if (raw === undefined) return UPDATE_PIN_RETRY_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : UPDATE_PIN_RETRY_DELAY_MS;
};

/** How the relaunch resolves the appRoot for journaling: the wrapper IS `<appRoot>/cli.js`. */
export const appRootFromArgv = (
  argv1: string | undefined,
  envOverride: string | undefined,
): string | null => {
  if (envOverride !== undefined && envOverride !== "") return envOverride;
  if (argv1 === undefined || argv1 === "") return null;
  const slash = Math.max(argv1.lastIndexOf("/"), argv1.lastIndexOf("\\"));
  return slash <= 0 ? null : argv1.slice(0, slash);
};

/**
 * Wait for `host:port` to free up: UPDATE_PIN_ATTEMPTS probes, UPDATE_PIN_RETRY_DELAY_MS apart (the dying
 * server's socket lingers a few seconds — the first retry wins that race every time).
 * True = free, false = still busy after the whole budget.
 */
export const waitForPinnedPort = (params: {
  readonly host: string;
  readonly port: number;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const attempts = params.attempts ?? UPDATE_PIN_ATTEMPTS;
    const delayMs = params.retryDelayMs ?? UPDATE_PIN_RETRY_DELAY_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(yield* Daemon.isPortInUse(params.host, params.port))) return true;
      if (attempt < attempts - 1) yield* Effect.sleep(Duration.millis(delayMs));
    }
    return false;
  });

export interface UpdateRelaunchInput {
  readonly flags: Daemon.ForwardableServerFlags;
  readonly statePath: string;
  readonly baseDir: string;
  readonly version: string;
  /** Journal writer for the port-busy outcome (injected — keeps this module journal-agnostic). */
  readonly journalPortBusy: Effect.Effect<void>;
  /** Test seam. */
  readonly waitForPort?: (host: string, port: number) => Effect.Effect<boolean>;
}

/**
 * stop → pinned-port gate → pinned launch. Exits (fails) with the journaled `port-busy` outcome
 * when the port never frees; otherwise delegates to the shipped launch path (which re-verifies
 * the pin itself — `pinnedPort: true` disables the free-port fallback).
 */
export const runUpdateRelaunch = (input: UpdateRelaunchInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    const host = Option.getOrElse(input.flags.host, () => Daemon.DEFAULT_DAEMON_HOST);
    const port = Option.getOrElse(input.flags.port, () => Daemon.DEFAULT_DAEMON_PORT);
    yield* Daemon.stopDaemon({ statePath: input.statePath, force: false });
    const wait =
      input.waitForPort ??
      ((h: string, p: number) =>
        waitForPinnedPort({ host: h, port: p, retryDelayMs: testPinDelayMs() }));
    const free = yield* wait(host, port);
    if (!free) {
      yield* Effect.logError("[auto-update] relaunch aborted: pinned port stayed busy", {
        host,
        port,
        attempts: UPDATE_PIN_ATTEMPTS,
      });
      yield* input.journalPortBusy;
      return yield* Effect.die(new Error(`pinned port ${String(port)} stayed busy`));
    }
    yield* Daemon.launchDaemon({
      flags: input.flags,
      statePath: input.statePath,
      baseDir: input.baseDir,
      version: input.version,
      pinnedPort: true,
    });
  });
