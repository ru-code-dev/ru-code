// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics importFromBarrel:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalErrorInEffectFailure:off
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { Console, Data, Duration, Effect, Schedule } from "effect";

import { initSpawnPolicy } from "./ru-fork/spawn/policy.ts";
import { resolveStartupCli, runStartupChecks } from "./ru-fork/preflight/preflight-startup.ts";
// ru-fork: shared TTY-aware ANSI palette + ready-banner extracted out
// of this file so both daemon and foreground surfaces share a visual style.
import { ARROW_DIM, ARROW_OK, ARROW_WARN, paint } from "./ru-fork/local-startup/cliPaint.ts";
import { printDaemonReadyBanner } from "./ru-fork/local-startup/daemonReadyBanner.ts";
import { deriveServerPaths } from "./config.ts";
import { DAEMON_HEALTH_PROBE_TIMEOUT_MS, DAEMON_SPAWN_TIMEOUT_MS } from "./timeouts.ts";
import { expandHomePath, resolveBaseDir } from "./os-jank.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { Open } from "./open.ts";

export class DaemonLauncherError extends Data.TaggedError("DaemonLauncherError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DaemonLauncherInput {
  readonly baseDirOverride: string | undefined;
  readonly devUrlOverride: URL | undefined;
  readonly forwardedArgs: ReadonlyArray<string>;
  readonly noBrowser: boolean;
  // ru-fork: skip the node/git/CLI preflight gate. Passed by the
  // user via --no-preflight-check; bin.ts forwards it here.
  readonly noPreflightCheck: boolean;
  // ru-fork: see injectExtraPathsFlag / windowsUseBashForFlag
  // in cli/config.ts. Consumed by initSpawnPolicy before preflight.
  readonly injectExtraPaths: string | undefined;
  readonly windowsUseBashFor: string | undefined;
}

export interface StopCommandInput {
  readonly baseDirOverride: string | undefined;
  readonly devUrlOverride: URL | undefined;
}

// ─── Output styling ────────────────────────────────────────────────────────
// ru-fork: palette + arrows moved to local-startup/cliPaint.ts for
// reuse; lineKV/headline kept inline because they're the daemon-launcher's
// own row arrangement (no other caller).
const lineKV = (key: string, value: string): string =>
  `    ${paint.dim(key.padEnd(6))}  ${paint.bold(paint.magenta(value))}`;
const headline = (arrow: string, text: string): string => `  ${arrow} ${paint.bold(text)}`;

const SPAWN_HEALTH_POLL_INTERVAL_MS = 200;
// `Effect.retry({ times: N })` means 1 initial attempt + N retries.
// 75 retries × 200ms = 15s of additional polling on top of the first try.
const SPAWN_HEALTH_POLL_RETRIES = 75;
const STOP_DRAIN_INTERVAL_MS = 100;
const STOP_DRAIN_RETRIES = 50; // ~5s drain budget after POST /shutdown

const probeHealth = (origin: string) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DAEMON_HEALTH_PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(`${origin}/health`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) => new DaemonLauncherError({ message: "health probe failed", cause }),
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const pollHealth = (statePath: string) =>
  Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(statePath);
    if (state._tag !== "Some") {
      return yield* Effect.fail(new Error("state file not yet written"));
    }
    const ok = yield* probeHealth(state.value.origin);
    if (!ok) {
      return yield* Effect.fail(new Error("health endpoint not yet ready"));
    }
    return state.value;
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(SPAWN_HEALTH_POLL_INTERVAL_MS)),
      times: SPAWN_HEALTH_POLL_RETRIES,
    }),
  );

const spawnDetachedServerCallback = (input: {
  readonly logPath: string;
  readonly forwardedArgs: ReadonlyArray<string>;
}) =>
  Effect.callback<number | undefined, Error>((resume) => {
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      return resume(
        Effect.fail(new Error("Could not resolve CLI entry path from process.argv[1].")),
      );
    }
    let logFd: number;
    try {
      fs.mkdirSync(nodePath.dirname(input.logPath), { recursive: true });
      logFd = fs.openSync(input.logPath, "a");
    } catch (cause) {
      return resume(Effect.fail(new Error(`failed to open launcher log: ${String(cause)}`)));
    }

    let settled = false;
    const finishOk = (pid: number | undefined) => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(logFd);
      } catch {
        // child has its own copy of the fd; ignore.
      }
      resume(Effect.succeed(pid));
    };
    const finishErr = (cause: unknown) => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(logFd);
      } catch {
        // best effort
      }
      resume(Effect.fail(new Error(`failed to spawn detached server: ${String(cause)}`)));
    };

    // Always pass `--no-browser` to the child: the launcher fetches the
    // canonical browser target via /pair/startup and owns the open call,
    // so a child auto-open would just race / duplicate.
    //
    // `--disable-warning=ExperimentalWarning` is a node flag (must precede
    // the script path) that suppresses the `node:sqlite` ExperimentalWarning
    // emitted at module-link time. Userland `process.emitWarning` overrides
    // can't catch it because it fires before any user module body runs.
    //
    // ru-fork: `--experimental-sqlite` is required on Node 22.6–22.17
    // (engines floor is 22.6 for IT-locked users). On 22.18+/23/24 it is a
    // silent no-op, so passing it unconditionally is safe.
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--experimental-sqlite",
          "--disable-warning=ExperimentalWarning",
          cliEntry,
          "start",
          "--no-browser",
          // ru-fork: parent already ran the preflight gate; tell
          // the child to skip its own. If the parent skipped too, the
          // child sees both flags and also skips — consistent outcome.
          "--no-preflight-check",
          ...input.forwardedArgs,
        ],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: process.env,
          // ru-fork: suppress the cmd-style console window (and its
          // taskbar entry) that Windows would otherwise attach to the
          // detached child. Ignored on macOS/Linux. Note: nodejs/node#21825
          // documents flakiness with `detached: true`; if a console still
          // leaks on user machines, escalate to a VBS / runhiddenconsole
          // wrapper.
          windowsHide: true,
        },
      );
    } catch (cause) {
      return finishErr(cause);
    }

    child.once("spawn", () => {
      child.unref();
      finishOk(child.pid);
    });
    child.once("error", finishErr);
  });

const spawnDetachedServer = (input: {
  readonly logPath: string;
  readonly forwardedArgs: ReadonlyArray<string>;
}) =>
  spawnDetachedServerCallback(input).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(DAEMON_SPAWN_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new Error(`spawn did not signal 'spawn' or 'error' within ${DAEMON_SPAWN_TIMEOUT_MS}ms`),
        ),
    }),
  );

const openBrowserSafely = (target: string) =>
  Effect.gen(function* () {
    const open = yield* Open;
    yield* open
      .openBrowser(target)
      .pipe(Effect.catch(() => Console.log(`Откройте ${target} в браузере`)));
  });

const fetchPairingStartupUrl = (origin: string) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DAEMON_HEALTH_PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(`${origin}/pair/startup`, {
          method: "POST",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { url?: unknown };
        return typeof body.url === "string" && body.url.length > 0 ? body.url : null;
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) => new DaemonLauncherError({ message: "pairing-startup request failed", cause }),
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const resolveDerivedPaths = (input: {
  readonly baseDirOverride: string | undefined;
  readonly devUrlOverride: URL | undefined;
  // ru-fork: resolver's app root — the default base dir when no override.
  readonly ourRoot: string;
}) =>
  Effect.gen(function* () {
    const baseDirOverrideExpanded =
      input.baseDirOverride !== undefined
        ? yield* expandHomePath(input.baseDirOverride.trim())
        : undefined;
    const baseDir = yield* resolveBaseDir(baseDirOverrideExpanded ?? input.ourRoot);
    return yield* deriveServerPaths(baseDir, input.devUrlOverride);
  });

const announceReady = (input: {
  readonly origin: string;
  readonly browserTarget: string;
  readonly noBrowser: boolean;
  readonly alreadyRunning: boolean;
}) =>
  Effect.gen(function* () {
    // ru-fork: visual layout moved to local-startup/daemonReadyBanner.ts
    // so daemon + foreground surfaces share the same bordered-box style.
    // URLs printed verbatim (literal 127.0.0.1 from the bind address) —
    // no longer rewritten to `localhost` so daemon and foreground both
    // print the same origin, avoiding browser same-origin-policy splits
    // (localStorage / cookies / theme are keyed by host string).
    yield* printDaemonReadyBanner({
      origin: input.origin,
      browserTarget: input.browserTarget,
      alreadyRunning: input.alreadyRunning,
    });
    if (!input.noBrowser) {
      yield* openBrowserSafely(input.browserTarget);
    }
  });

export const runDaemonLauncher = (input: DaemonLauncherInput) =>
  Effect.gen(function* () {
    // ru-fork: spawn policy must be set before any spawn
    // (preflight + the detached child both spawn). The spawned child
    // re-parses argv and re-applies — duplicate PATH entries from the
    // re-prepend are harmless. See
    // ru-fork-instrumental/changes/startap-environment.md.
    initSpawnPolicy({
      injectExtraPaths: input.injectExtraPaths,
      windowsUseBashFor: input.windowsUseBashFor,
    });
    // ru-fork: resolve cli.js / CLI config dir / app root once (shared resolver).
    // Always runs — the daemon's base-dir derivation and the spawned child both
    // depend on it; a failed resolution stops here. The node/git/CLI version
    // checks are gated: parent runs them once, the spawn below forwards
    // --no-preflight-check so the child skips. See
    // `ru-fork-instrumental/changes/deamon/startap-checks.md`.
    const cli = yield* resolveStartupCli;
    if (!input.noPreflightCheck) {
      yield* runStartupChecks(cli.cliJs);
    }
    const derivedPaths = yield* resolveDerivedPaths({ ...input, ourRoot: cli.ourRoot });
    const { serverRuntimeStatePath, logsDir } = derivedPaths;
    const launcherLogPath = nodePath.join(logsDir, "ru-fork.log");

    const existingState = yield* readPersistedServerRuntimeState(serverRuntimeStatePath);
    if (existingState._tag === "Some") {
      const reachable = yield* probeHealth(existingState.value.origin);
      if (reachable) {
        const browserTarget =
          (yield* fetchPairingStartupUrl(existingState.value.origin)) ?? existingState.value.origin;
        yield* announceReady({
          origin: existingState.value.origin,
          browserTarget,
          noBrowser: input.noBrowser,
          alreadyRunning: true,
        });
        return;
      }
      yield* Console.log("");
      yield* Console.log(
        headline(ARROW_WARN, `устаревшее состояние на ${existingState.value.origin} — перезапуск`),
      );
    }

    yield* Console.log("");
    yield* Console.log(headline(ARROW_DIM, "запуск ru-fork в фоне…"));
    yield* Console.log(lineKV("журнал работы", launcherLogPath));
    yield* spawnDetachedServer({
      logPath: launcherLogPath,
      forwardedArgs: input.forwardedArgs,
    });

    const ready = yield* pollHealth(serverRuntimeStatePath).pipe(
      Effect.mapError(
        () =>
          new Error(
            [
              `ru-fork did not become healthy in time.`,
              `Logs: ${launcherLogPath}`,
              `If a previous server is hung, run \`ru-fork stop\` (or kill the process manually) and try again.`,
            ].join("\n"),
          ),
      ),
    );

    const browserTarget = (yield* fetchPairingStartupUrl(ready.origin)) ?? ready.origin;
    yield* announceReady({
      origin: ready.origin,
      browserTarget,
      noBrowser: input.noBrowser,
      alreadyRunning: false,
    });
  });

export const runStopCommand = (input: StopCommandInput) =>
  Effect.gen(function* () {
    // ru-fork: resolve the same app root as start, so we look for the running
    // server's runtime-state under the right tree (bin split included).
    const cli = yield* resolveStartupCli;
    const derivedPaths = yield* resolveDerivedPaths({ ...input, ourRoot: cli.ourRoot });
    const state = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
    if (state._tag !== "Some") {
      yield* Console.log("");
      yield* Console.log(headline(ARROW_DIM, "ru-fork не запущен"));
      yield* Console.log("");
      return;
    }

    const sent = yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DAEMON_HEALTH_PROBE_TIMEOUT_MS);
        try {
          const response = await fetch(`${state.value.origin}/shutdown`, {
            method: "POST",
            signal: controller.signal,
          });
          return response.ok;
        } finally {
          clearTimeout(timer);
        }
      },
      catch: (cause) => new DaemonLauncherError({ message: "shutdown request failed", cause }),
    }).pipe(Effect.catch(() => Effect.succeed(false)));

    if (!sent) {
      yield* Console.log("");
      yield* Console.log(
        headline(
          ARROW_WARN,
          `запрос на остановку не дошёл до ${state.value.origin} — возможно, уже остановлен`,
        ),
      );
      yield* Console.log("");
      return;
    }

    // Drain: poll /health until the server stops responding, so the user knows
    // the process is actually gone before this command exits.
    const drained = yield* Effect.gen(function* () {
      const ok = yield* probeHealth(state.value.origin);
      if (ok) {
        return yield* Effect.fail(new Error("server still responding"));
      }
      return true;
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(STOP_DRAIN_INTERVAL_MS)),
        times: STOP_DRAIN_RETRIES,
      }),
      Effect.catch(() => Effect.succeed(false)),
    );

    yield* Console.log("");
    if (drained) {
      yield* Console.log(headline(ARROW_OK, "ru-fork остановлен"));
      yield* Console.log(lineKV("был", state.value.origin));
    } else {
      yield* Console.log(
        headline(
          ARROW_WARN,
          `запрошена остановка на ${state.value.origin} — ещё отвечает, подождите немного`,
        ),
      );
    }
    yield* Console.log("");
  });
