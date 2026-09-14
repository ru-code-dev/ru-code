// ru-code (cli-reload): THE reload — one function, one authority (design D1).
//
// Order, and why it is this order:
//   1. claim the reload latch — a second press joins the running pass (owner ruling R2);
//   2. kill EVERYTHING qwen in one pass: every adapter's `stopAll()` (idle sessions + warm
//      spares instantly, active turns settled, SIGKILL + scope close, pool drained, pending
//      reaps awaited — QwenAdapter.ts:5615) together with every tracked one-shot `-p` child
//      (D3, the hole `stopAll` never covered — research A-G3);
//   3. run the qwen sweep with RELOAD wording so nothing stays parked (B-G1/B-G4): parked
//      approvals and questions closed, dangling compaction and agent rows stopped, streaming
//      messages finalized, live session rows written `stopped` with `lastError` preserved
//      (owner ruling R4 — the sweep's own `preserveLastError`);
//   4. delete the configured profile-dir entries, per live instance, deduplicated (R3);
//   5. clear the auth flag so the NEXT spawn re-authenticates behind the gate (D2).
//
// There are no timeouts and no "wait for things to finish" anywhere (owner ruling R6): the
// kill pass is SIGKILL, and the only wait in it is the adapter's own shared cancel grace.
// The version-probe cache is deliberately NOT invalidated (owner ruling R5).
//
// Failure: logged at debug with the cause and reported as the fieldless `CliReloadError` —
// the modal shows ONE generic line and nothing else (owner ruling R7).

import {
  DELETE_ON_CLI_RESTART,
  QWEN_KIND,
  REMOVE_SESSION_FILES_ON_EXPIRY,
} from "@ru-code/branding";
import { CliReloadError, QwenSettings, type ProviderInstanceConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveCliProfileSettings } from "../qwen/profileResolver.ts";
import {
  runQwenSweepFromRuntime,
  type QwenSweepRuntimeServices,
} from "../startup/qwenBootSweep.ts";
import { removeCliResetEntries } from "./deletePaths.ts";
import {
  clearAuthOk,
  hasOutstandingSpawnClients,
  nextSpawnClientsChange,
  withSchedulerReloading,
} from "./cliSpawnScheduler.ts";
import {
  killAllLiveCliChildren,
  listLiveCliChildren,
  nextLiveCliChildrenChange,
} from "./liveCliChildren.ts";
import { listQwenInstances, notePoolsDrained, runExclusiveReload } from "./reloadRuntime.ts";
import { CLI_RELOAD_SWEEP_TEXTS } from "./sweepCopy.ts";

export class CliReloadEngine extends Context.Service<
  CliReloadEngine,
  {
    /**
     * Stop every CLI process this server owns, close the work they left parked, delete the
     * configured profile-dir entries and re-arm the auth gate. Resolves when all of it is
     * done; a second call while one is running resolves with the running one's result.
     */
    readonly reload: Effect.Effect<void, CliReloadError>;
  }
>()("t3/ru-code/cli-reload/CliReloadService/CliReloadEngine") {}

/** Distinct, `~`-expanded profile dirs across the live instances (research G11 / D-G1). */
const profileDirsOf = (instances: ReadonlyArray<{ readonly profileDir: string }>) =>
  Array.from(new Set(instances.map((instance) => instance.profileDir).filter((d) => d.length > 0)));

/**
 * The engine with its step-3 sweep INJECTED. The production build (below) passes the real
 * `runQwenSweepFromRuntime(CLI_RELOAD_SWEEP_TEXTS)`; a spec that exercises the kill / delete /
 * latch / auth halves without a database passes a recording stub and asserts the call.
 */
export const makeCliReloadEngineWith = (deps: { readonly sweep: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The scope the reload fiber lives in: this service's own. `Layer.effect` runs its
    // construction in the LAYER's scope, so this is the layer's lifetime — provided the layer
    // is built in a long-lived graph, which is why `CliReloadHostLayer` is also merged into
    // `serverApplicationLayer` (server.ts), exactly like `AnalyticsHostLayer` before it:
    // "long-lived, so its forked scan outlives any one request". Memoization then gives ws.ts
    // the SAME instance. A reload therefore outlives the request that asked for it, and is
    // interrupted only by server shutdown closing this scope.
    const serviceScope = yield* Effect.scope;
    const runReload = Effect.gen(function* () {
      const instances = yield* listQwenInstances;
      yield* Effect.logDebug("[cli-reload] reload starting", { instances: instances.length });

      // Step 1 — re-arm the gate FIRST. Every CLI is about to die, so the token's health is
      // unknown from this instant; leaving the flag set until the end meant a reload that
      // failed or was interrupted disarmed the gate exactly when it was most needed
      // (adversary A-3).
      yield* clearAuthOk;

      // Steps 2-3 — ONE uninterruptible unit. If the kill ran, the sweep runs: a fleet killed
      // without its parked approvals/questions/compaction rows closed is the worst state this
      // feature can produce, and it must not be reachable by an interrupt or by a failure
      // between the two. (`stopAllWarm` takes the same position for the same reason.)
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // THE KILL PASS IS A FIXPOINT, NOT A SNAPSHOT.
          //
          // A client granted the permit a moment before the scheduler flipped to `reloading`
          // is already past the gate: it spawns its CLI child INSIDE this window, and a pass
          // that killed one snapshot of the registry would resolve with that child alive
          // (adversary R2-2). The reload's own drain widens the window — `stopAll` holds the
          // pool mutex, so a granted `startSession` blocks in `warmPool.take` and spawns the
          // instant the drain lets go.
          //
          // QUIESCENT = the live-child registry is empty AND the scheduler reports no client
          // granted-but-unfinished. Each iteration settles every session, drains every pool and
          // SIGKILLs everything registered; if we are not quiescent we yield and go round
          // again. We never WAIT for a holder to finish authenticating — its child is killed as
          // soon as it registers, which is the primary use case (a CLI parked at `authenticate`
          // on a lapsed token is exactly why the user pressed Reload).
          //
          // IT TERMINATES, and after it non-quiescence is impossible by construction: no new
          // client can be granted (the scheduler is `reloading`, and the grant is the only way
          // past it), so `inFlight` only shrinks; a client that is still outstanding either has
          // not spawned yet — the next iteration kills whatever it registers — or has had its
          // child killed, which fails its operation and removes it. There is therefore nothing
          // left to log afterwards, and the old "leftovers" debug branch is gone with it.
          //
          // IT IS EVENT-DRIVEN, NOT A SPIN. Re-testing in a loop re-ran the whole pass — every
          // `stopAll`, the pool-mutex drain, `killAll` — at memory speed inside this
          // uninterruptible unit, purely because one granted client had not spawned yet
          // (adversary R3-1 measured ~145k iterations/s). The two owners of the quiescence state
          // each publish a change signal, so the loop sleeps until the state it is waiting on
          // ACTUALLY changes. No timeout, no clock, no sleep (R6, R9): the only things that can
          // wake it are a registry mutation and a grant/release, both in-process.
          //
          // BOUND: each iteration after the first is preceded by one of exactly two events — a
          // registered child appearing or disappearing, or a holder being granted or releasing.
          // No grant can happen while the scheduler is `reloading`, so the loop runs at most
          // (children + holders + 1) times.
          for (;;) {
            yield* Effect.forEach(instances, (instance) => instance.stopAll, {
              concurrency: "unbounded",
              discard: true,
            });
            yield* killAllLiveCliChildren;
            // Take both handles BEFORE reading the state. A change landing between the read and
            // the await completes a handle we are already holding, so it cannot be lost.
            const registryChanged = yield* nextLiveCliChildrenChange;
            const clientsChanged = yield* nextSpawnClientsChange;
            const live = yield* listLiveCliChildren;
            const outstanding = yield* hasOutstandingSpawnClients;
            if (live.length === 0 && !outstanding) break;
            yield* Effect.logDebug("[cli-reload] kill pass not quiescent — waiting for a change", {
              live: live.length,
              outstandingSpawnClients: outstanding,
            });
            yield* Effect.raceFirst(
              Deferred.await(registryChanged),
              Deferred.await(clientsChanged),
            );
          }
          // Every pool is empty now, and that is OUR doing — claim the transition so no later
          // spawn path reads it as an idle reset.
          yield* notePoolsDrained;
          // Close what the dead processes left parked, in reload wording.
          yield* deps.sweep;
        }),
      );

      // Step 4 — the configured deletions. May fail; the failure is the RPC's.
      yield* removeCliResetEntries({
        dirs: profileDirsOf(instances),
        entries: DELETE_ON_CLI_RESTART,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* Effect.logDebug("[cli-reload] reload done");
    });

    return {
      reload: runExclusiveReload(
        serviceScope,
        // The scheduler is held in `reloading` for the WHOLE pass, so nothing — not even a
        // client already parked on the permit — can spawn behind the kill (adversary A-1).
        withSchedulerReloading(runReload).pipe(
          Effect.catchCause((cause) =>
            // Owner ruling R7: the cause lives here and nowhere else; the wire carries a
            // fieldless error and the modal shows one generic sentence.
            Effect.logDebug("[cli-reload] reload failed", { cause }).pipe(
              Effect.andThen(Effect.fail(new CliReloadError())),
            ),
          ),
        ),
      ),
    } satisfies CliReloadEngine["Service"];
  });

/**
 * Production build. The sweep resolves five runtime services (directory / projection / engine
 * / crypto / sql); they are captured ONCE here so the service's `reload` has no requirements
 * of its own and the RPC handler stays a thin forward, exactly like the auto-update handlers.
 */
const makeCliReloadEngine = Effect.gen(function* () {
  const sweepContext = yield* Effect.context<QwenSweepRuntimeServices>();
  return yield* makeCliReloadEngineWith({
    sweep: runQwenSweepFromRuntime(CLI_RELOAD_SWEEP_TEXTS).pipe(
      Effect.provideContext(sweepContext),
    ),
  });
});

export const CliReloadEngineLive = Layer.effect(CliReloadEngine, makeCliReloadEngine);

// ── boot hook (D4) ───────────────────────────────────────────────────────────────────────

const decodeQwenSettingsOption = Schema.decodeUnknownOption(QwenSettings);
/** The driver's own default envelope (QwenDriver.ts:114 `defaultConfig`). */
const defaultQwenSettings = Schema.decodeSync(QwenSettings)({});

/**
 * The dirs the CONFIGURED qwen instances would run from. Used ONLY at boot, where no adapter
 * has registered yet and there is therefore no live instance to read `resolved.dir` from —
 * so the boot hook resolves through the SAME resolver the spawn uses (profileResolver.ts),
 * for the default instance plus every qwen envelope in the settings file.
 */
export const resolveConfiguredQwenProfileDirs = (
  providerInstances: Readonly<Record<string, ProviderInstanceConfig>>,
  preflight: { readonly cliJs: string; readonly cliConfigDir: string },
): ReadonlyArray<string> => {
  const dirs = new Set<string>();
  const add = (settings: Parameters<typeof resolveCliProfileSettings>[0]) => {
    const dir = resolveCliProfileSettings(settings, preflight).dir;
    if (dir.length > 0) dirs.add(expandHomePath(dir));
  };
  // The default qwen instance is implicit — `DEFAULT_SERVER_SETTINGS.providerInstances` is
  // `{}` and the driver's `defaultConfig()` is `decodeQwenSettings({})`.
  add(defaultQwenSettings);
  for (const instance of Object.values(providerInstances)) {
    if (String(instance.driver) !== QWEN_KIND) continue;
    const decoded = decodeQwenSettingsOption(instance.config ?? {});
    if (decoded._tag !== "Some") continue;
    add(decoded.value);
  }
  return Array.from(dirs);
};

/**
 * Boot: apply the configured deletions ONCE, after the boot sweep and before anything spawns
 * (owner ruling R10 ships `REMOVE_SESSION_FILES_ON_EXPIRY` false, so this is dormant until a
 * fork turns it on). Never fails — a cleanup problem must not block startup, exactly like the
 * sweep it follows.
 */
export const runCliResetOnBoot = Effect.gen(function* () {
  if (!REMOVE_SESSION_FILES_ON_EXPIRY || DELETE_ON_CLI_RESTART.length === 0) return;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  yield* removeCliResetEntries({
    dirs: resolveConfiguredQwenProfileDirs(settings.providerInstances, {
      cliJs: serverConfig.cliJs,
      cliConfigDir: serverConfig.cliConfigDir,
    }),
    entries: DELETE_ON_CLI_RESTART,
  });
}).pipe(
  Effect.catchCause((cause) => Effect.logDebug("[cli-reload] boot cleanup failed", { cause })),
);
