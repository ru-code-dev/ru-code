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
import { findFreePort } from "./net.ts";
import { daemonLogPath, ensureParentDir } from "./paths.ts";
import { failWith } from "./report.ts";
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

    // Reuse a healthy instance (D1); reclaim our own wedged one.
    const existing = yield* inspectExistingDaemon(input.statePath, host);
    if (Option.isSome(existing) && existing.value.listening) {
      yield* Console.log(
        formatAlreadyRunningBanner({
          url: existing.value.origin, // plain origin — persisted token is stale
          version: input.version,
          runningFor: runningFor(existing.value.startedAt, nowMs),
          pid: existing.value.pid,
        }),
      );
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
      const port = yield* findFreePort(host, desiredPort);
      if (Option.isNone(port)) {
        return yield* failWith(
          L(
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
      }).pipe(
        Effect.catch((error) =>
          failWith(
            L(
              `Failed to spawn the daemon: ${String(error.cause)}`,
              `Не удалось запустить демон: ${String(error.cause)}`,
            ),
          ),
        ),
      );

      const outcome = yield* awaitDaemonReady({ statePath: input.statePath, childPid });
      if (outcome._tag === "ready") {
        yield* Console.log(
          formatReadyBanner({
            url: outcome.url,
            version: input.version,
            runningFor: runningFor(outcome.startedAt, nowMs),
            pid: childPid,
            logPath,
          }),
        );
        return;
      }
      if (outcome._tag === "timeout") {
        if (Option.isSome(outcome.url)) {
          yield* Console.log(
            formatReadyBanner({
              url: outcome.url.value,
              version: input.version,
              runningFor: runningFor(
                Option.getOrElse(outcome.startedAt, () => ""),
                nowMs,
              ),
              pid: childPid,
              logPath,
            }),
          );
          return;
        }
        return yield* failWith(
          L(
            `The daemon did not become ready in time. See the log: ${logPath}`,
            `Демон не запустился вовремя. Смотрите журнал: ${logPath}`,
          ),
        );
      }
      // outcome._tag === "exited" → likely lost the port to a racer; loop re-picks.
    }

    return yield* failWith(
      L(
        `Could not start the daemon after ${MAX_LAUNCH_ATTEMPTS} attempts. See the log: ${logPath}`,
        `Не удалось запустить демон после ${MAX_LAUNCH_ATTEMPTS} попыток. Смотрите журнал: ${logPath}`,
      ),
    );
  });
