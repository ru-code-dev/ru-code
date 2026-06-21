// ru-fork: MCP instance supervisor. Owns the in-memory registry of live MCP
// instances keyed by resolved-config hash (dedup: two bindings with the same
// resolved config share one instance, refcounted by their (project,server) keys).
//
// Monitoring is advisory and holds NO connections: a single sweep loop reprobes
// every instance on an interval (probeOnce = connect → listTools → close). The
// status transition is a small state machine. Reconcile is a pure diff against
// the registry Ref. Nothing here writes config or touches qwen.

import {
  IsoDateTime,
  type McpProbeRecord,
  type McpRuntimeStatus,
  type McpTool,
  type McpTransport,
} from "@t3tools/contracts";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  probeOnce,
  type ProbeResult,
  type ResolvedServerConfig,
} from "@ru-fork/mcp-core";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { McpProbeCacheRepository } from "../../persistence/Services/McpProbeCache.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

// The loop just ticks to check which instances are DUE — actual probes are
// gated by the per-transport recheck intervals, so a frequent tick is cheap.
const SWEEP_INTERVAL = Duration.seconds(60);
const OFFLINE_THRESHOLD = 3;

/** Short description of what a probe targets, for logs. */
const probeTarget = (resolved: ResolvedServerConfig): string =>
  resolved.transport === "stdio"
    ? `${resolved.command ?? ""} ${(resolved.args ?? []).join(" ")}`.trim()
    : (resolved.httpUrl ?? "");

/** One (project,server) reference onto a shared instance, as `${projectId}:${serverId}`. */
export type InstanceRef = string;

export interface SupervisorInstance {
  readonly hash: string;
  /** Authored-config cache key (cwd-independent) — the probe-cache row this instance maps to. */
  readonly configKey: string;
  readonly resolved: ResolvedServerConfig;
  readonly refs: ReadonlySet<InstanceRef>;
  readonly status: McpRuntimeStatus;
  readonly message: string | null;
  readonly latencyMs: number | null;
  readonly checkedAt: string | null;
  /** Epoch ms of the last probe (null = never) — drives the due check without re-parsing ISO. */
  readonly checkedAtMs: number | null;
  readonly discoveredTools: ReadonlyArray<McpTool>;
  readonly consecutiveFailures: number;
}

const MINUTE_MS = 60_000;

/**
 * A ref is `${projectId}:${serverId}` (a project binding) or `catalog:${serverId}`
 * (the catalog default, even when unbound). Split into its two parts; the project
 * part is "catalog" for catalog refs, which never matches a real project id.
 */
function parseRef(ref: InstanceRef): { readonly projectPart: string; readonly serverId: string } {
  const colon = ref.indexOf(":");
  return colon > 0
    ? { projectPart: ref.slice(0, colon), serverId: ref.slice(colon + 1) }
    : { projectPart: "", serverId: ref };
}

export function instanceInWatched(
  instance: SupervisorInstance,
  watched: ReadonlySet<string>,
): boolean {
  for (const ref of instance.refs) {
    if (watched.has(parseRef(ref).projectPart)) {
      return true;
    }
  }
  return false;
}

/**
 * The sweep's per-instance decision (pure, so it can be unit-tested):
 *  - a NEVER-checked instance is never auto-probed (no probing on load); its first probe comes
 *    only from a manual recheck or a config-affecting change (reactor `probeHashes`);
 *  - otherwise only the WATCHED (active) project's already-probed instances re-probe, and only
 *    once their per-transport interval has elapsed (`watched === null` ⇒ all).
 */
export function isSweepDue(
  instance: SupervisorInstance,
  watched: ReadonlySet<string> | null,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  // A never-probed instance is NEVER auto-probed (no probing on load) — its first probe comes only
  // from a manual recheck or a config-affecting change (reactor `probeHashes`). The sweep re-checks
  // ONLY already-probed instances of the watched project, on their transport interval.
  if (instance.checkedAtMs === null) {
    return false;
  }
  if (watched !== null && !instanceInWatched(instance, watched)) {
    return false;
  }
  return isProbeDue(instance, nowMs, localIntervalMs, remoteIntervalMs);
}

/** Which live instances a manual recheck targets — all filters are AND-combined. */
export interface RecheckFilter {
  readonly projectId?: string;
  readonly serverId?: string;
  readonly transport?: McpTransport;
}

/** True when any of the instance's refs satisfies the (project, server) filter. */
export function instanceMatchesRecheck(
  instance: SupervisorInstance,
  filter: RecheckFilter,
): boolean {
  if (filter.transport !== undefined && instance.resolved.transport !== filter.transport) {
    return false;
  }
  for (const ref of instance.refs) {
    const { projectPart, serverId } = parseRef(ref);
    if (filter.projectId !== undefined && projectPart !== filter.projectId) {
      continue;
    }
    if (filter.serverId !== undefined && serverId !== filter.serverId) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * A never-probed instance is always due; otherwise re-probe only when its
 * transport's interval (minutes) has elapsed. 0 minutes ⇒ never auto re-check.
 */
export function isProbeDue(
  instance: SupervisorInstance,
  nowMs: number,
  localIntervalMs: number,
  remoteIntervalMs: number,
): boolean {
  if (instance.checkedAtMs === null) {
    return false; // never probed ⇒ not auto-due (probe only on manual / config change)
  }
  const intervalMs = instance.resolved.transport === "stdio" ? localIntervalMs : remoteIntervalMs;
  if (intervalMs <= 0) {
    return false;
  }
  return nowMs - instance.checkedAtMs >= intervalMs;
}

export interface DesiredInstance {
  readonly hash: string;
  readonly configKey: string;
  readonly resolved: ResolvedServerConfig;
  readonly refs: ReadonlySet<InstanceRef>;
}

export interface McpSupervisorShape {
  /**
   * Reconcile the registry to exactly `desired` (add/keep/drop by hash). Returns the hashes that
   * were newly added by this reconcile (not previously registered) — brand-new instances or configs
   * whose key just changed. The reactor force-probes these on a config-affecting change.
   */
  readonly reconcile: (
    desired: ReadonlyMap<string, DesiredInstance>,
  ) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Scope auto-probing to these project ids (what the client is viewing). Empty
   * ⇒ probe nothing. Until first called the supervisor probes ALL projects, so
   * probing never silently stops if the client never signals.
   */
  readonly setWatchedProjects: (projectIds: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Force a probe NOW of every live instance matching the filter, bypassing the
   * due-gate (manual "Проверить" / refresh). Coalesces with in-flight probes.
   * Resolves once the triggered probes settle; results land via `changes`.
   */
  readonly recheck: (filter: RecheckFilter) => Effect.Effect<void>;
  /** Force a probe NOW of the live instances with these hashes (config-change driven). */
  readonly probeHashes: (hashes: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly currentInstances: Effect.Effect<ReadonlyArray<SupervisorInstance>>;
  /** Hashes with a probe currently in flight — drives the UI «проверка…» indicator. */
  readonly currentInFlight: Effect.Effect<ReadonlySet<string>>;
  /** A tick on every registry/status change. */
  readonly changes: Stream.Stream<void>;
  /** Start the health-sweep loop (call inside the reactor scope). */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * ru-fork test seam: run ONE sweep tick synchronously — the exact body the periodic `start()` loop
   * repeats every 60s. Exposed so the sweep orchestration (due-filter, watched scope, interval gate)
   * can be tested deterministically without waiting on the real schedule. Production never calls this.
   */
  readonly sweepOnce: Effect.Effect<void>;
}

export class McpSupervisor extends Context.Service<McpSupervisor, McpSupervisorShape>()(
  "@ru-code/ru-code/ru-fork/mcp/McpSupervisor",
) {}

// Exported for unit testing (alongside isProbeDue/isSweepDue).
export function nextStatus(
  result: ProbeResult,
  previousFailures: number,
): { readonly status: McpRuntimeStatus; readonly consecutiveFailures: number } {
  switch (result.status) {
    case "online":
      return { status: "online", consecutiveFailures: 0 };
    case "offline": {
      const consecutiveFailures = previousFailures + 1;
      // A HARD failure (connection refused/closed, ENOENT, spawn error) is down NOW → red. Only a
      // TIMEOUT gets the degraded/retry buffer (a slow server may recover within OFFLINE_THRESHOLD).
      const status: McpRuntimeStatus =
        !result.timedOut || consecutiveFailures >= OFFLINE_THRESHOLD ? "offline" : "degraded";
      return { status, consecutiveFailures };
    }
  }
}

const makeMcpSupervisor = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const probeCache = yield* McpProbeCacheRepository;
  const registryRef = yield* Ref.make<ReadonlyMap<string, SupervisorInstance>>(new Map());
  // null ⇒ never told which project is active ⇒ probe all (safe default).
  const watchedProjectsRef = yield* Ref.make<ReadonlySet<string> | null>(null);
  // Hashes currently being probed — coalesces concurrent sweep + manual probes so
  // one authored config is never connected to twice at the same instant.
  const inFlightRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const changesPubSub = yield* PubSub.unbounded<void>();

  const setWatchedProjects: McpSupervisorShape["setWatchedProjects"] = (projectIds) =>
    Ref.set(watchedProjectsRef, new Set(projectIds));

  const publishChange = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

  const cachedSeed = (configKey: string) =>
    probeCache.getByKey({ configKey }).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.sync(() => undefined)),
    );

  const reconcile: McpSupervisorShape["reconcile"] = (desired) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("[mcp] reconcile", {
        instances: desired.size,
        refs: [...desired.values()].reduce((total, instance) => total + instance.refs.size, 0),
      });
      const current = yield* Ref.get(registryRef);
      // Hydrate brand-new instances from the persisted cache (status/tools/checkedAt)
      // so a restart shows last-known state and does NOT immediately re-probe.
      const seeds = new Map<string, McpProbeRecord>();
      for (const [hash, desiredInstance] of desired) {
        if (current.has(hash)) {
          continue;
        }
        const record = yield* cachedSeed(desiredInstance.configKey);
        if (record) {
          seeds.set(hash, record);
        }
      }
      const next = new Map<string, SupervisorInstance>();
      for (const [hash, desiredInstance] of desired) {
        const existing = current.get(hash);
        if (existing) {
          next.set(hash, {
            ...existing,
            configKey: desiredInstance.configKey,
            resolved: desiredInstance.resolved,
            refs: desiredInstance.refs,
          });
          continue;
        }
        const seed = seeds.get(hash);
        next.set(
          hash,
          seed
            ? {
                hash,
                configKey: desiredInstance.configKey,
                resolved: desiredInstance.resolved,
                refs: desiredInstance.refs,
                status: seed.status === "online" ? "online" : "offline",
                message: seed.lastError,
                latencyMs: null,
                checkedAt: seed.checkedAt,
                checkedAtMs: seed.checkedAtMs,
                discoveredTools: seed.tools,
                consecutiveFailures: seed.status === "online" ? 0 : 1,
              }
            : {
                hash,
                configKey: desiredInstance.configKey,
                resolved: desiredInstance.resolved,
                refs: desiredInstance.refs,
                status: "unchecked",
                message: null,
                latencyMs: null,
                checkedAt: null,
                checkedAtMs: null,
                discoveredTools: [],
                consecutiveFailures: 0,
              },
        );
      }
      yield* Ref.set(registryRef, next);
      yield* publishChange;
      // Hashes that are brand-new OR that gained a ref this reconcile (e.g. a config equal to an
      // already-registered unchecked catalog default that was just bound to a project). Both warrant
      // a probe on an eager (user-driven) change; incomplete instances never reach here (computeDesired
      // excludes them), so this can only ever probe COMPLETE instances. The reactor force-probes the
      // returned hashes on a config-affecting change (item 3).
      return [...next.entries()]
        .filter(([hash, instance]) => {
          const before = current.get(hash);
          return !before || [...instance.refs].some((ref) => !before.refs.has(ref));
        })
        .map(([hash]) => hash);
    });

  const applyProbeResult = (
    hash: string,
    result: ProbeResult,
    checkedAt: string,
    checkedAtMs: number,
  ) =>
    Ref.update(registryRef, (current) => {
      const latest = current.get(hash);
      if (!latest) {
        return current; // instance was reconciled away mid-probe
      }
      const transition = nextStatus(result, latest.consecutiveFailures);
      const next = new Map(current);
      next.set(hash, {
        ...latest,
        status: transition.status,
        consecutiveFailures: transition.consecutiveFailures,
        message: result.message ?? null,
        latencyMs: result.latencyMs,
        checkedAt,
        checkedAtMs,
        discoveredTools: result.status === "online" ? result.tools : latest.discoveredTools,
      });
      return next;
    }).pipe(Effect.andThen(publishChange));

  // Claim the in-flight slot for a hash; returns true if another fiber already
  // holds it (so the caller should skip). Explicit tuple type avoids `as const`.
  const claimInFlight = (hash: string): Effect.Effect<boolean> =>
    Ref.modify(inFlightRef, (set): readonly [boolean, ReadonlySet<string>] =>
      set.has(hash) ? [true, set] : [false, new Set([...set, hash])],
    );

  const releaseInFlight = (hash: string) =>
    Ref.update(inFlightRef, (set) => {
      const next = new Set(set);
      next.delete(hash);
      return next;
    });

  const runProbe = (instance: SupervisorInstance) =>
    Effect.gen(function* () {
      const timeoutMs = instance.resolved.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      yield* Effect.logDebug("[mcp] probe start", {
        hash: instance.hash,
        transport: instance.resolved.transport,
        target: probeTarget(instance.resolved),
        timeoutMs,
      });
      const result = yield* Effect.promise(() => probeOnce(instance.resolved, timeoutMs));
      const checkedAtMs = yield* Clock.currentTimeMillis;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.logDebug("[mcp] probe result", {
        hash: instance.hash,
        target: probeTarget(instance.resolved),
        status: result.status,
        latencyMs: result.latencyMs,
        tools: result.tools.length,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.message ? { message: result.message } : {}),
      });
      yield* applyProbeResult(instance.hash, result, checkedAt, checkedAtMs);
      // Write-through to the persisted, config-keyed cache (shared across projects
      // on the same authored config; survives restart).
      yield* probeCache
        .upsert({
          configKey: instance.configKey,
          transport: instance.resolved.transport,
          status: result.status,
          tools: result.tools,
          lastError: result.message ?? null,
          serverDescription: result.serverDescription ?? null,
          serverWebsiteUrl: result.serverWebsiteUrl ?? null,
          checkedAt: IsoDateTime.make(checkedAt),
          checkedAtMs,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("[mcp] probe cache write failed", { hash: instance.hash, error }),
          ),
        );
    });

  // Probe one instance, coalescing with any in-flight probe of the same config. The claim+release are
  // bracketed (acquireUseRelease) so the in-flight slot is released even if the fiber is interrupted —
  // `claimInFlight` only mutates when it returns false, so we release only when we acquired.
  const probeInstance = (instance: SupervisorInstance) =>
    Effect.acquireUseRelease(
      claimInFlight(instance.hash),
      (alreadyRunning) =>
        alreadyRunning
          ? Effect.void // another fiber is already probing this exact config
          : Effect.gen(function* () {
              yield* publishChange; // flip the UI to «проверка…» the instant the probe starts
              yield* runProbe(instance);
            }),
      (alreadyRunning) =>
        alreadyRunning
          ? Effect.void
          : Effect.gen(function* () {
              yield* releaseInFlight(instance.hash);
              yield* publishChange; // and again when it settles, so «проверка…» clears
            }),
    );

  const probeHashes: McpSupervisorShape["probeHashes"] = (hashes) =>
    Effect.gen(function* () {
      if (hashes.length === 0) {
        return;
      }
      const registry = yield* Ref.get(registryRef);
      const matched = hashes
        .map((hash) => registry.get(hash))
        .filter((instance): instance is SupervisorInstance => instance !== undefined);
      yield* Effect.forEach(matched, probeInstance, { concurrency: 4, discard: true });
    });

  const recheck: McpSupervisorShape["recheck"] = (filter) =>
    Effect.gen(function* () {
      const instances = [...(yield* Ref.get(registryRef)).values()];
      const matched = instances.filter((instance) => instanceMatchesRecheck(instance, filter));
      yield* Effect.logDebug("[mcp] manual recheck", { ...filter, matched: matched.length });
      yield* Effect.forEach(matched, probeInstance, { concurrency: 4, discard: true });
    });

  const runSweep = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => null),
    );
    const instances = [...(yield* Ref.get(registryRef)).values()];
    if (settings === null || instances.length === 0) {
      return; // can't read cadence, or nothing to probe — keep last status
    }
    const localIntervalMs = settings.mcp.recheckLocalMinutes * MINUTE_MS;
    const remoteIntervalMs = settings.mcp.recheckRemoteMinutes * MINUTE_MS;
    // Both intervals 0 ⇒ no periodic re-checking at all: the loop is off. The first probe of any
    // server then comes only from a manual recheck or a config-affecting change.
    if (localIntervalMs <= 0 && remoteIntervalMs <= 0) {
      return;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const watched = yield* Ref.get(watchedProjectsRef);
    // The loop ticks every 60s but probes only what's due (watched project + elapsed interval;
    // never-probed instances are excluded — see `isSweepDue`).
    const due = instances.filter((instance) =>
      isSweepDue(instance, watched, nowMs, localIntervalMs, remoteIntervalMs),
    );
    if (due.length === 0) {
      return;
    }
    yield* Effect.logDebug("[mcp] sweep", { due: due.length, total: instances.length });
    yield* Effect.forEach(due, probeInstance, { concurrency: 4, discard: true });
  });

  const currentInstances: McpSupervisorShape["currentInstances"] = Ref.get(registryRef).pipe(
    Effect.map((registry) => [...registry.values()]),
  );

  const currentInFlight: McpSupervisorShape["currentInFlight"] = Ref.get(inFlightRef);

  const start: McpSupervisorShape["start"] = () =>
    Effect.forkScoped(runSweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))).pipe(
      Effect.asVoid,
    );

  return {
    reconcile,
    setWatchedProjects,
    recheck,
    probeHashes,
    currentInstances,
    currentInFlight,
    changes: Stream.fromPubSub(changesPubSub),
    start,
    sweepOnce: runSweep, // ru-fork test seam: one tick of the periodic sweep loop (see shape doc)
  } satisfies McpSupervisorShape;
});

export const McpSupervisorLive = Layer.effect(McpSupervisor, makeMcpSupervisor);
