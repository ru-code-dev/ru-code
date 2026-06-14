// ru-fork: the MCP reactor — the half that turns authored state (catalog +
// bindings) into the supervisor's *desired* instance set. It owns no
// connections and no health logic (that is McpSupervisor); it only diffs the
// projections and calls `supervisor.reconcile`.
//
// Flow: a drainable worker reconciles on every relevant domain event
// (`mcp.*` / project create/update/delete) plus an initial tick at startup
// (so bindings restored from the DB are reconciled after a restart). At startup
// it reconciles the shipped built-in TEMPLATES against the installed catalog by
// `builtinId` (add new / update changed / remove dropped — see McpBuiltins); on
// `project.created` it optionally autobinds the builtins (gated by
// `settings.mcp.autobindDefaults`, default off). Sync/autobind go through normal
// commands, so the resulting events flow back through the worker and reconcile
// naturally.

import { CommandId, McpServerId, type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import type { McpCatalogServer, McpVarValue } from "@t3tools/contracts";
import {
  configCacheKey,
  configIdentity,
  dedupHash,
  effectiveTimeoutMs,
  missingRequiredVars,
  resolveConfig,
} from "@ru-fork/mcp-core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { McpBindingRepository } from "../../persistence/Services/McpBinding.ts";
import { McpCatalogRepository } from "../../persistence/Services/McpCatalog.ts";
import { McpProbeCacheRepository } from "../../persistence/Services/McpProbeCache.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  type McpBuiltinDefinition,
} from "./McpBuiltins.ts";
import { MCP_BUILTINS } from "./mcpBuiltinDefinitions.ts";
import { McpOverlay } from "./McpOverlay.ts";
import { MCP_VAR_SECRET_PREFIX } from "./McpSecretNames.ts";
import { collectVarSecretRefs, materializeSecretValues, missingSecretVarNames } from "./McpSecrets.ts";
import { type DesiredInstance, McpSupervisor } from "./McpSupervisor.ts";

// ru-fork: a reactor-internal commandId is UNIQUE per dispatch, never content-stable. The engine
// dedups by commandId (OrchestrationEngine: an "accepted" receipt short-circuits before the decider),
// so a stable id makes the FIRST dispatch the only one that ever runs — re-add after remove, a 2nd
// orphan prune, a re-cleared description, etc. would be silently dropped. The reconcile-side state diffs
// (the hash gate / presence / orphan / empty-field checks) are the real idempotency guard, so a fresh
// uuid here is correct — and matches CheckpointReactor / ProviderCommandReactor. (autobind is the
// deliberate exception below: its stable id IS its "bind a builtin to a project once ever" guard.)
const mkReconcileCommandId = (tag: string) =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

export interface McpReactorShape {
  /** Start reacting to authored MCP/project changes. Run inside the reactor scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the reconcile queue is idle. Test seam. */
  readonly drain: Effect.Effect<void>;
}

export class McpReactor extends Context.Service<McpReactor, McpReactorShape>()(
  "ru-fork/mcp/McpReactor",
) {}

/**
 * What the worker was woken for. `eager` reconciles force-probe newly-appeared instances (a
 * config-affecting change happened); the startup/hydrate reconcile is NOT eager (no probing on
 * load). A `project-created` always reconciles eagerly after autobinding.
 */
type ReactorSignal =
  | { readonly kind: "reconcile"; readonly eager: boolean }
  | { readonly kind: "project-created"; readonly projectId: ProjectId };

const isReconcileRelevant = (event: OrchestrationEvent): boolean =>
  event.type.startsWith("mcp.") ||
  event.type === "project.deleted" ||
  event.type === "project.meta-updated";

/**
 * ru-fork: reconcile shipped built-ins against the installed catalog by builtinId — add new, update on
 * content-hash change (3-way merge preserves user values/vars/extraArgs), remove no-longer-shipped.
 * Acquires the engine + catalog repo from context. Parameterized by the definition list + platform
 * ONLY so the lifecycle can be driven from tests against a real engine; production calls it with
 * `MCP_BUILTINS` + `process.platform` (see `reconcileBuiltins` below). Behaviour is identical to the
 * loop it replaced — this is a pure extraction (a testability seam), not a logic change.
 */
export const reconcileBuiltinsWith = (
  definitions: ReadonlyArray<McpBuiltinDefinition>,
  platform: NodeJS.Platform,
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const catalogRepository = yield* McpCatalogRepository;
    const catalog = yield* catalogRepository.listAll();
    const installedByBuiltinId = new Map(
      catalog
        .filter((server) => server.builtinId !== null)
        .map((server) => [server.builtinId, server]),
    );
    const shippedBuiltinIds = new Set<string>();
    for (const definition of definitions) {
      const config = builtinConfigForPlatform(definition, platform);
      if (config === null) {
        continue; // unsupported on this OS — skip
      }
      shippedBuiltinIds.add(definition.builtinId);
      const serverId = builtinServerId(definition.builtinId);
      const hash = builtinHash(config, definition);
      const installed = installedByBuiltinId.get(definition.builtinId);
      if (installed && installed.builtinHash === hash) {
        continue; // up to date
      }
      // ru-fork #2: skip-on-collision — never duplicate/clobber a DIFFERENT server that already has
      // this config (e.g. a user hand-added the same command). The built-in stays on its last good
      // config and self-heals once the conflicting server is gone.
      const shippedIdentity = configIdentity(config, builtinShippedVars(definition), [], {});
      const collision = catalog.find(
        (server) =>
          server.id !== McpServerId.make(serverId) &&
          configIdentity(server.config, server.vars, server.extraArgs, server.extraHeaders) ===
            shippedIdentity,
      );
      if (collision) {
        yield* Effect.logDebug("mcp reactor: built-in skipped (config conflicts with existing server)", {
          builtinId: definition.builtinId,
          conflictsWith: collision.id,
        });
        continue;
      }
      yield* engine
        .dispatch({
          type: "mcp.builtin-sync",
          // ru-fork: unique per dispatch (see mkReconcileCommandId). Identity is `serverId` (stable), and
          // whether to dispatch at all is decided by the hash GATE above (`installed.builtinHash === hash`
          // ⇒ skip), so a no-op restart mints nothing and a changed definition / a re-add always re-syncs.
          commandId: mkReconcileCommandId(`mcp-builtin-sync:${definition.builtinId}`),
          serverId: McpServerId.make(serverId),
          builtinId: definition.builtinId,
          builtinHash: hash,
          name: definition.name,
          description: definition.description ?? null,
          websiteUrl: definition.websiteUrl ?? null,
          config,
          shippedVars: builtinShippedVars(definition),
          timeoutMs: definition.timeoutMs ?? null,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("mcp reactor failed to sync builtin", {
              builtinId: definition.builtinId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
    // Remove installed built-ins no longer shipped (cascade: bindings + secret GC handle the rest).
    for (const installed of catalog) {
      if (installed.builtinId !== null && !shippedBuiltinIds.has(installed.builtinId)) {
        yield* engine
          .dispatch({
            type: "mcp.server-remove",
            commandId: mkReconcileCommandId(`mcp-builtin-remove:${installed.builtinId}`),
            serverId: installed.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("mcp reactor failed to remove dropped builtin", {
                builtinId: installed.builtinId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to reconcile builtins", { cause: Cause.pretty(cause) }),
    ),
  );

/**
 * ru-fork: B3 ② — fill an empty catalog description/websiteUrl from the server's cached probe metadata.
 * Extracted (context-acquiring) ONLY as a testability seam; behaviour identical to the inlined closure.
 */
export const backfillServerMetadataEffect = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const catalogRepository = yield* McpCatalogRepository;
  const probeCache = yield* McpProbeCacheRepository;
  const catalog = yield* catalogRepository.listAll();
  yield* Effect.forEach(
    catalog,
    (server) =>
      Effect.gen(function* () {
        if (server.description !== null && server.websiteUrl !== null) {
          return; // nothing to fill
        }
        const configKey = configCacheKey(
          server.config,
          server.vars,
          {},
          server.extraArgs,
          server.extraHeaders,
        );
        const cached = yield* probeCache.getByKey({ configKey });
        if (Option.isNone(cached)) {
          return;
        }
        const row = cached.value;
        const trimmedDesc = row.serverDescription?.trim();
        const trimmedUrl = row.serverWebsiteUrl?.trim();
        const patch = {
          ...(server.description === null && trimmedDesc ? { description: trimmedDesc } : {}),
          ...(server.websiteUrl === null && trimmedUrl ? { websiteUrl: trimmedUrl } : {}),
        };
        if (Object.keys(patch).length === 0) {
          return;
        }
        yield* engine
          .dispatch({
            type: "mcp.server-update",
            commandId: mkReconcileCommandId(
              `mcp-meta-backfill:${server.id}:${Object.keys(patch).toSorted().join("-")}`,
            ),
            serverId: server.id,
            patch,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("mcp reactor failed to backfill server metadata", {
                serverId: server.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }),
    { discard: true },
  );
});

/**
 * ru-fork: item 11 — drop per-project var-values stranded by a catalog edit that removed a var
 * (ref-preserving). Extracted (context-acquiring) ONLY as a testability seam; behaviour identical.
 */
export const pruneOrphanedVarValuesEffect = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const catalog = yield* catalogRepository.listAll();
  const bindings = yield* bindingRepository.listAll();
  const declaredByServer = new Map(
    catalog.map((server) => [server.id, new Set(server.vars.map((variable) => variable.name))]),
  );
  for (const binding of bindings) {
    const declared = declaredByServer.get(binding.serverId);
    if (!declared) {
      continue;
    }
    const names = Object.keys(binding.varValues);
    const keep = names.filter((name) => declared.has(name));
    if (keep.length === names.length) {
      continue; // no orphans
    }
    yield* engine
      .dispatch({
        type: "mcp.binding-set",
        commandId: mkReconcileCommandId(`mcp-prune-vars:${binding.projectId}:${binding.serverId}`),
        projectId: binding.projectId,
        serverId: binding.serverId,
        patch: { varValues: {}, keepVarValues: keep },
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("mcp reactor failed to prune orphaned var values", {
            projectId: binding.projectId,
            serverId: binding.serverId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("mcp reactor failed to scan bindings for orphaned var values", {
      cause: Cause.pretty(cause),
    }),
  ),
);

/**
 * ru-fork: compute the DESIRED probe instance set from catalog + bindings — every enabled, complete
 * catalog default (ref `catalog:<id>`) and every enabled, complete binding (ref `<project>:<server>`),
 * deduplicated by resolved-config hash (refcounted). Context-acquiring; extracted ONLY as a testability
 * seam, behaviour identical to the inlined closure.
 */
export const computeDesiredEffect = Effect.gen(function* () {
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const secretStore = yield* ServerSecretStore;
  const serverConfig = yield* ServerConfig;
  const provideSecretStore = Effect.provideService(ServerSecretStore, secretStore);
  const mergeDesired = (
    desired: Map<string, DesiredInstance>,
    server: McpCatalogServer,
    varValues: Readonly<Record<string, McpVarValue>>,
    timeoutMs: number | undefined,
    ref: string,
  ) =>
    Effect.gen(function* () {
      const secretValues = yield* materializeSecretValues(server.vars, varValues).pipe(provideSecretStore);
      const resolved = resolveConfig({
        config: server.config,
        vars: server.vars,
        varValues,
        extraArgs: server.extraArgs,
        extraHeaders: server.extraHeaders,
        timeoutMs,
        context: { projectCwd: serverConfig.mcpProbeCwd, secretValues },
      });
      const hash = dedupHash(resolved);
      const configKey = configCacheKey(
        server.config,
        server.vars,
        varValues,
        server.extraArgs,
        server.extraHeaders,
      );
      const existing = desired.get(hash);
      desired.set(
        hash,
        existing
          ? { ...existing, refs: new Set([...existing.refs, ref]) }
          : { hash, configKey, resolved, refs: new Set([ref]) },
      );
    });

  const catalog = yield* catalogRepository.listAll();
  const bindings = yield* bindingRepository.listAll();
  const serverById = new Map(catalog.map((server) => [server.id, server]));
  const desired = new Map<string, DesiredInstance>();
  for (const server of catalog) {
    if (!server.enabled) {
      continue; // ⑬ catalog-disabled ⇒ never probed
    }
    if (missingRequiredVars(server.vars, {}).length > 0) {
      continue;
    }
    // ru-fork #9: a declared required secret whose stored value is gone ⇒ incomplete (never launch blank).
    if ((yield* missingSecretVarNames(server.vars, {}).pipe(provideSecretStore)).length > 0) {
      continue;
    }
    yield* mergeDesired(desired, server, {}, server.timeoutMs ?? undefined, `catalog:${server.id}`);
  }
  for (const binding of bindings) {
    if (!binding.enabled) {
      continue;
    }
    const server = serverById.get(binding.serverId);
    if (!server) {
      continue;
    }
    if (!server.enabled) {
      continue;
    }
    if (missingRequiredVars(server.vars, binding.varValues).length > 0) {
      continue; // incomplete ⇒ not probed/spawned (§D8)
    }
    // ru-fork #9: missing stored secret ⇒ incomplete (don't launch a blank credential).
    if (
      (yield* missingSecretVarNames(server.vars, binding.varValues).pipe(provideSecretStore)).length > 0
    ) {
      continue;
    }
    yield* mergeDesired(
      desired,
      server,
      binding.varValues,
      effectiveTimeoutMs(server, binding),
      `${binding.projectId}:${binding.serverId}`,
    );
  }
  return desired;
});

/**
 * ru-fork: item 10 — prune secret .bin files no longer referenced by any catalog var or binding value.
 * Context-acquiring; extracted ONLY as a testability seam, behaviour identical.
 */
export const gcOrphanedSecretsEffect = Effect.gen(function* () {
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const secretStore = yield* ServerSecretStore;
  const catalog = yield* catalogRepository.listAll();
  const bindings = yield* bindingRepository.listAll();
  const serverById = new Map(catalog.map((server) => [server.id, server]));
  const live = new Set<string>();
  for (const server of catalog) {
    for (const ref of collectVarSecretRefs(server.vars, {})) {
      live.add(ref);
    }
  }
  for (const binding of bindings) {
    const server = serverById.get(binding.serverId);
    if (!server) {
      continue;
    }
    for (const ref of collectVarSecretRefs(server.vars, binding.varValues)) {
      live.add(ref);
    }
  }
  yield* secretStore.pruneByPrefix(MCP_VAR_SECRET_PREFIX, live);
}).pipe(
  Effect.catch((error) => Effect.logError("mcp reactor failed to GC orphaned secrets", { error })),
);

/**
 * ru-fork: auto-bind every catalog built-in to a new project IFF `settings.mcp.autobindDefaults` is on
 * (default off). Context-acquiring; extracted ONLY as a testability seam, behaviour identical.
 */
export const autobindBuiltinsForProjectWith = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const catalogRepository = yield* McpCatalogRepository;
    const engine = yield* OrchestrationEngineService;
    const settings = yield* serverSettings.getSettings.pipe(Effect.catch(() => Effect.succeed(null)));
    if (settings === null || !settings.mcp.autobindDefaults) {
      return;
    }
    const catalog = yield* catalogRepository.listAll();
    const builtins = catalog.filter((server) => server.builtinId !== null);
    yield* Effect.forEach(
      builtins,
      (builtin) =>
        engine
          .dispatch({
            type: "mcp.binding-set",
            commandId: CommandId.make(`server:mcp-autobind:${projectId}:${builtin.id}`),
            projectId,
            serverId: builtin.id,
            patch: { enabled: true },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("mcp reactor failed to autobind builtin", {
                projectId,
                serverId: builtin.id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to autobind builtins for project", {
        projectId,
        cause: Cause.pretty(cause),
      }),
    ),
  );

const make = Effect.gen(function* () {
  const catalogRepository = yield* McpCatalogRepository;
  const bindingRepository = yield* McpBindingRepository;
  const probeCache = yield* McpProbeCacheRepository;
  const supervisor = yield* McpSupervisor;
  const engine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const overlay = yield* McpOverlay;
  // Provided so the extracted reactor effects (which `yield*` ServerSecretStore) run here.
  const secretStore = yield* ServerSecretStore;

  const computeDesired = computeDesiredEffect.pipe(
    Effect.provideService(McpCatalogRepository, catalogRepository),
    Effect.provideService(McpBindingRepository, bindingRepository),
    Effect.provideService(ServerSecretStore, secretStore),
    Effect.provideService(ServerConfig, serverConfig),
  );

  const gcOrphanedSecrets = gcOrphanedSecretsEffect.pipe(
    Effect.provideService(McpCatalogRepository, catalogRepository),
    Effect.provideService(McpBindingRepository, bindingRepository),
    Effect.provideService(ServerSecretStore, secretStore),
  );

  // B3 ②: back-fill catalog `description`/`websiteUrl` from a server's first successful probe — but
  // ONLY when the catalog field is empty (a shipped/user value always wins). Reads the server's
  // default-config cache row and dispatches a metadata-only `mcp.server-update`. Replay-idempotent
  // (deterministic, field-scoped commandId); converges (once filled, the next pass produces no patch).
  const backfillServerMetadata = backfillServerMetadataEffect.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(McpCatalogRepository, catalogRepository),
    Effect.provideService(McpProbeCacheRepository, probeCache),
    // ru-fork #1: self-contained error absorption — it now runs directly in processSignal (after the
    // probe), no longer wrapped by reconcileNow's outer catch.
    Effect.catchCause((cause) =>
      Effect.logError("mcp reactor failed to back-fill server metadata", { cause: Cause.pretty(cause) }),
    ),
  );

  const reconcileNow: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
    const desired = yield* computeDesired;
    const added = yield* supervisor.reconcile(desired);
    // GC: drop persisted cache rows whose authored config no longer exists in the
    // live desired set (catalog default removed / override changed or dropped).
    const liveConfigKeys = new Set([...desired.values()].map((instance) => instance.configKey));
    // Never run a "delete-all" on an empty desired set (a transient all-incomplete state must not wipe
    // the cache); orphan rows are tiny and the next non-empty reconcile cleans them.
    if (liveConfigKeys.size > 0) {
      yield* probeCache
        .deleteKeysNotIn([...liveConfigKeys])
        .pipe(
          Effect.catch((error) =>
            Effect.logError("mcp reactor failed to GC probe cache", { error }),
          ),
        );
    }
    yield* gcOrphanedSecrets; // item 10 — prune secret .bin files no longer referenced
    return added;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("mcp reactor failed to reconcile desired instances", {
          cause: Cause.pretty(cause),
        });
        const empty: ReadonlyArray<string> = [];
        return empty; // cast-free: a failed reconcile added nothing to probe
      }),
    ),
  );

  // ru-fork: the reactor NO LONGER writes overlays or restarts sessions. The overlay is written at
  // turn-start (ProviderCommandReactor), which also detects an overlay change vs. what the live
  // session spawned with and re-spawns on the next turn (history preserved via resume). See
  // mcp-specs/current/WORKING-LOGIC.md §12. This dissolves the startup race + the stale-session bug.

  // Reconcile shipped built-ins against the installed catalog by builtinId: add new, update on
  // content-hash change (3-way merge preserves user values/vars/extraArgs), remove deleted. Runs at
  // startup. NOT eager (no probing on load). Unsupported platform (no config variant) ⇒ skip.
  const reconcileBuiltins = reconcileBuiltinsWith(MCP_BUILTINS, process.platform).pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(McpCatalogRepository, catalogRepository),
  );

  const autobindBuiltinsForProject = (projectId: ProjectId) =>
    autobindBuiltinsForProjectWith(projectId).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(McpCatalogRepository, catalogRepository),
      Effect.provideService(OrchestrationEngineService, engine),
    );

  // item 11: drop var values stranded by a catalog edit that removed a var. The resolver already
  // ignores unknown names, so this is hygiene + makes the secret GC exact. Ref-preserving (no
  // plaintext needed) — `keepVarValues` carries the surviving names' existing refs through.
  const pruneOrphanedVarValues = pruneOrphanedVarValuesEffect.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(McpCatalogRepository, catalogRepository),
    Effect.provideService(McpBindingRepository, bindingRepository),
  );

  const processSignal = (signal: ReactorSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const eager = signal.kind === "project-created" ? true : signal.eager;
      if (signal.kind === "project-created") {
        yield* autobindBuiltinsForProject(signal.projectId);
      }
      yield* pruneOrphanedVarValues; // item 11 — drop stranded var values (ref-preserving)
      const added = yield* reconcileNow;
      if (eager) {
        // A config-affecting change (or new project) just landed — probe the newly-appeared
        // instances NOW instead of waiting for the sweep (item 3). Cosmetic edits add nothing.
        yield* supervisor.probeHashes(added);
      }
      // ru-fork #1: back-fill catalog description/websiteUrl from the probe cache. MUST run AFTER
      // probeHashes — a fresh add has no cache row until the eager probe writes it, so an earlier pass
      // (inside reconcileNow) saw nothing. Idempotent + converges; description is not in the overlay
      // fingerprint, so this never respawns a session. On the non-eager startup path it reads the
      // prior-session cache.
      yield* backfillServerMetadata;
    });

  const worker = yield* makeDrainableWorker(processSignal);

  const start: McpReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.logDebug("[mcp] reactor starting");
    // ru-fork: reconcile the shipped built-ins BEFORE subscribing. `engine.dispatch` resolves only
    // after its event is published, so by the time this returns every `mcp.builtin-sync` event has
    // already been published — to a PubSub with no reactor subscriber yet. PubSub never replays to a
    // late subscriber, so the seed cannot feed back as an eager "change": a fresh install does NOT
    // probe on load (item 2). The explicit non-eager reconcile below registers the new built-ins as
    // «не проверено» until a real trigger.
    yield* reconcileBuiltins;
    // Subscribe AFTER seeding: only genuine post-startup user/runtime changes drive an eager probe.
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type === "project.created") {
          return worker.enqueue({ kind: "project-created", projectId: event.payload.projectId });
        }
        if (event.type === "project.deleted") {
          // B4 ③: remove the deleted project's overlay dir (the genuine orphan — a deleted *server*
          // self-heals via fingerprint), then reconcile (bindings already cascade; this GCs the rest).
          return overlay
            .removeOverlay(event.payload.projectId)
            .pipe(Effect.andThen(worker.enqueue({ kind: "reconcile", eager: true })));
        }
        if (isReconcileRelevant(event)) {
          // A user/runtime change (catalog/binding edit, autobind) ⇒ probe what changed now.
          return worker.enqueue({ kind: "reconcile", eager: true });
        }
        return Effect.void;
      }),
    );
    // Initial reconcile: cover bindings restored from the DB on restart — NOT eager (no probing
    // on load; cached status is shown, never-probed stays «не проверено» until a trigger).
    yield* worker.enqueue({ kind: "reconcile", eager: false });
  });

  return { start, drain: worker.drain } satisfies McpReactorShape;
});

export const McpReactorLive = Layer.effect(McpReactor, make);
