// ru-code: the daemon launcher — a thin orchestrator over focused helpers. Port
// policy: prefer 7777 (or --port); reuse a healthy instance; reclaim our own stale
// one; if the port is taken by anything else, fall back to the next free port; and
// if the child still dies during startup (EADDRINUSE race), re-pick and retry —
// so a busy port never surfaces as a crash. The child opens the browser itself.

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { L } from "@ru-code/localization";

import { formatAlreadyRunningBanner, formatReadyBanner } from "./banner.ts";
import { type ForwardableServerFlags, resolveDaemonHost, resolveDaemonPort } from "./childArgs.ts";
import { DEFAULT_DAEMON_PORT, MAX_LAUNCH_ATTEMPTS } from "./constants.ts";
import { inspectExistingDaemon } from "./daemonStatus.ts";
import { formatDuration } from "./duration.ts";
import { formatLaunchSuccessJson } from "./launchReport.ts";
import { findFreePort, isPortInUse } from "./net.ts";
import { daemonLogPath, ensureParentDir } from "./paths.ts";
import { failWith, failWithJson } from "./report.ts";
import { spawnServerChild } from "./spawnServerChild.ts";
import { reapOrphanedChildren, terminateInstance } from "./terminate.ts";
import { awaitDaemonReady } from "./waitForReady.ts";

export interface DaemonLaunchInput {
  /** The parsed server flags (subset we forward to the child). */
  readonly flags: ForwardableServerFlags;
  /** Absolute path to the app's `server-runtime.json`. */
  readonly statePath: string;
  /** The resolved base dir — forwarded so the child agrees on every derived path. */
  readonly baseDir: string;
  /** The app version (`apps/server/package.json`), shown in the banner. */
  readonly version: string;
  /**
   * ru-code auto-update relaunch: the child must bind EXACTLY the desired port
   * (the SW updating page polls that origin — a drifted port is invisible to
   * the browser). True ⇒ no free-port fallback: busy = fail. Normal launches
   * omit this and keep today's prefer-then-fallback policy.
   */
  readonly pinnedPort?: boolean;
  /**
   * ru-code `--json`: the installer launches the app and needs the outcome, not a
   * banner. True ⇒ no banner at all and exactly ONE line on stdout — the success
   * record for every branch where the app is up, the failure record for every
   * hard stop (nothing on stderr). Parent-only: never forwarded to the child.
   */
  readonly jsonOutput?: boolean;
}

/** Human "running for" string from the recorded ISO start time to `nowMs`. */
const runningFor = (startedAtIso: string, nowMs: number): string =>
  Option.match(DateTime.make(startedAtIso), {
    onNone: () => formatDuration(0),
    onSome: (started) => formatDuration(nowMs - DateTime.toEpochMillis(started)),
  });

export const launchDaemon = (input: DaemonLaunchInput): Effect.Effect<void> =>
  Effect.gen(function* () {
    const host = resolveDaemonHost(input.flags);
    const desiredPort = resolveDaemonPort(input.flags, DEFAULT_DAEMON_PORT);
    const logPath = daemonLogPath(input.statePath);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* ensureParentDir(logPath);

    // ru-code: --json — ONE shared success/failure line for every branch below, so
    // "the app is up" and "the app is not" look identical whichever way we got there.
    const jsonOutput = input.jsonOutput === true;
    const emitSuccess = (params: {
      readonly url: string;
      readonly pid: number;
      readonly banner: () => string;
    }): Effect.Effect<void> =>
      Console.log(
        jsonOutput
          ? formatLaunchSuccessJson({
              url: params.url,
              version: input.version,
              pid: params.pid,
            })
          : params.banner(),
      );
    const fail = (message: string): Effect.Effect<never> =>
      jsonOutput ? failWithJson(message, logPath) : failWith(message);

    // Reuse a healthy instance (D1); reclaim our own wedged one.
    const existing = yield* inspectExistingDaemon(input.statePath, host);
    if (Option.isSome(existing) && existing.value.listening) {
      yield* emitSuccess({
        url: existing.value.origin, // plain origin — persisted token is stale
        pid: existing.value.pid,
        banner: () =>
          formatAlreadyRunningBanner({
            url: existing.value.origin,
            version: input.version,
            runningFor: runningFor(existing.value.startedAt, nowMs),
            pid: existing.value.pid,
          }),
      });
      return;
    }
    if (Option.isSome(existing) && existing.value.alive) {
      // Reclaim our wedged instance — terminateInstance kills the server AND
      // cleans its children, so the explicit orphan reap below is not needed.
      yield* terminateInstance({ pid: existing.value.pid, statePath: input.statePath });
    } else {
      // start-fresh: reap any orphaned child processes (e.g. acp from a prior
      // crash) before spawning — journal pids by default, signature sweep as the
      // fallback backend. Skipped on the reuse path above (we returned early).
      yield* reapOrphanedChildren(input.statePath);
    }

    // Spawn on a free port (prefer desiredPort). If the child dies during startup,
    // re-pick a free port and retry — this closes the EADDRINUSE race.
    for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      // ru-code: pinned mode (auto-update relaunch) never falls back to another port.
      const port =
        input.pinnedPort === true
          ? (yield* isPortInUse(host, desiredPort))
            ? Option.none<number>()
            : Option.some(desiredPort)
          : yield* findFreePort(host, desiredPort);
      if (Option.isNone(port)) {
        return yield* fail(
          input.pinnedPort === true
            ? L(`Port ${desiredPort} is busy.`, `Порт ${desiredPort} занят.`)
            : L(
                `No free port found starting at ${desiredPort}.`,
                `Свободный порт не найден начиная с ${desiredPort}.`,
              ),
        );
      }

      const childPid = yield* spawnServerChild({
        flags: input.flags,
        baseDir: input.baseDir,
        host,
        port: port.value,
        logPath,
        // Only the FIRST attempt starts a fresh log; a retry appends, so the attempt that actually
        // explains the failure is not overwritten by the one that follows it.
        appendLog: attempt > 0,
      }).pipe(
        Effect.catch((error) =>
          fail(
            L(
              `Failed to spawn the daemon: ${String(error.cause)}`,
              `Не удалось запустить демон: ${String(error.cause)}`,
            ),
          ),
        ),
      );

      const outcome = yield* awaitDaemonReady({ statePath: input.statePath, childPid });
      if (outcome._tag === "ready") {
        yield* emitSuccess({
          url: outcome.url,
          pid: childPid,
          banner: () =>
            formatReadyBanner({
              url: outcome.url,
              version: input.version,
              runningFor: runningFor(outcome.startedAt, nowMs),
              pid: childPid,
              logPath,
            }),
        });
        return;
      }
      if (outcome._tag === "timeout") {
        // ru-code: a url means the child DID bind — the app is up, so this is a
        // success on both surfaces (banner and --json), not a timeout failure.
        if (Option.isSome(outcome.url)) {
          const readyUrl = outcome.url.value;
          yield* emitSuccess({
            url: readyUrl,
            pid: childPid,
            banner: () =>
              formatReadyBanner({
                url: readyUrl,
                version: input.version,
                runningFor: runningFor(
                  Option.getOrElse(outcome.startedAt, () => ""),
                  nowMs,
                ),
                pid: childPid,
                logPath,
              }),
          });
          return;
        }
        return yield* fail(
          L(
            `The daemon did not become ready in time. See the log: ${logPath}`,
            `Демон не запустился вовремя. Смотрите журнал: ${logPath}`,
          ),
        );
      }
      // outcome._tag === "exited" → likely lost the port to a racer; loop re-picks.
    }

    return yield* fail(
      L(
        `Could not start the daemon after ${MAX_LAUNCH_ATTEMPTS} attempts. See the log: ${logPath}`,
        `Не удалось запустить демон после ${MAX_LAUNCH_ATTEMPTS} попыток. Смотрите журнал: ${logPath}`,
      ),
    );
  });
