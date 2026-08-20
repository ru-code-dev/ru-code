// ru-code: host wiring for the MCP manager engine (@smart-tools/qwen-cli-mcp-manager).
//
// The package ships every service (supervisor / reactor / overlay / runtime / query /
// session-overlay gate / SQL repos) and declares five ports — the ONLY host couplings.
// This module implements them from the ambient host graph:
//   - McpManagerConfig      — overlay/probe dirs derived from ServerConfig.stateDir +
//                             the MCP_ENGINE_USE_OVERLAY kill-switch (@ru-code/qwen)
//   - McpManagerSecretStore — over auth/ServerSecretStore (opaque bytes; the at-rest cipher
//                             lives in the PACKAGE above this port — McpSecrets.write/readMcpSecret)
//                             + pruneByPrefix over the on-disk layout
//   - McpManagerSettings    — over ServerSettingsService (settings.mcp.*)
//   - McpManagerProjects    — over the read-model ProjectionProjectRepository
//   - McpManagerEngine      — over OrchestrationEngineService (dispatch + domain events)

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ProjectId } from "@t3tools/contracts";
import { MCP_ENGINE_USE_OVERLAY } from "@ru-code/qwen/constants";
import {
  McpEngineError,
  McpManagerConfig,
  McpManagerEngine,
  McpManagerProjects,
  McpManagerSecretStore,
  McpManagerSettings,
  McpProjectsError,
  McpRuntimeServicesLive,
  McpSecretStoreError,
  McpSessionOverlay,
  type McpManagerDomainEvent,
} from "@smart-tools/qwen-cli-mcp-manager/server";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

/** Overlay/probe dirs live under `<stateDir>/mcp/…` (created here, owner-only parents come
 * from the atomic writes). The kill-switch is the same constant the qwen spawn env reads. */
export const mcpConfigLayer = Layer.effect(
  McpManagerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const overlayDir = path.join(config.stateDir, "mcp", "overlays");
    const probeCwd = path.join(config.stateDir, "mcp", "probe-cwd");
    yield* Effect.orDie(fileSystem.makeDirectory(overlayDir, { recursive: true }));
    yield* Effect.orDie(fileSystem.makeDirectory(probeCwd, { recursive: true }));
    return McpManagerConfig.of({ overlayDir, probeCwd, useOverlay: MCP_ENGINE_USE_OVERLAY });
  }),
);

/** Adapter over the host secret store: Option→null on get; pruneByPrefix implemented over
 * the store's on-disk layout (`<secretsDir>/<name>.bin`) — best-effort GC, never fails.
 *
 * The port carries OPAQUE bytes: the at-rest cipher for MCP var secrets is a package
 * guarantee applied above this port (McpSecrets.writeMcpSecret/readMcpSecret), so this
 * adapter stays a plain byte store and the upstream ServerSecretStore keeps its stock
 * plaintext behaviour for every non-MCP secret. */
export const mcpSecretStoreLayer = Layer.effect(
  McpManagerSecretStore,
  Effect.gen(function* () {
    const store = yield* ServerSecretStore;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const failed = (cause: unknown) =>
      new McpSecretStoreError({
        message: cause instanceof Error ? cause.message : "Secret store operation failed.",
        cause,
      });
    return McpManagerSecretStore.of({
      get: (name) => store.get(name).pipe(Effect.map(Option.getOrNull), Effect.mapError(failed)),
      set: (name, value) => store.set(name, value).pipe(Effect.mapError(failed)),
      pruneByPrefix: (prefix, keep) =>
        Effect.gen(function* () {
          const entries = yield* fileSystem
            .readDirectory(config.secretsDir)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          for (const entry of entries) {
            if (!entry.endsWith(".bin")) {
              continue;
            }
            const name = entry.slice(0, -".bin".length);
            if (!name.startsWith(prefix) || keep.has(name)) {
              continue;
            }
            // Best-effort GC. `force` makes an already-gone file a no-op; a real remove failure
            // is logged (not lost) but must NOT abort pruning the remaining orphans.
            yield* fileSystem.remove(path.join(config.secretsDir, entry), { force: true }).pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("mcp secret prune: failed to remove a secret file", {
                  entry,
                  cause,
                }),
              ),
            );
          }
        }),
    });
  }),
);

/** settings.mcp.* → the flat snapshot the package reads; unreadable settings ⇒ null
 * (the engine keeps its last behaviour, mirroring the pre-extraction orElseSucceed). */
export const mcpSettingsLayer = Layer.effect(
  McpManagerSettings,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    return McpManagerSettings.of({
      current: serverSettings.getSettings.pipe(
        Effect.map((settings) => ({
          recheckLocalMinutes: settings.mcp.recheckLocalMinutes,
          recheckRemoteMinutes: settings.mcp.recheckRemoteMinutes,
          autobindDefaults: settings.mcp.autobindDefaults,
        })),
        Effect.orElseSucceed(() => null),
      ),
    });
  }),
);

/** Same identity rule as the skills/agents catalogs: the port speaks the stable ProjectId,
 * resolved to the project's main workspaceRoot via the read-model repo. */
export const mcpProjectsLayer = Layer.effect(
  McpManagerProjects,
  Effect.gen(function* () {
    const projectRepo = yield* ProjectionProjectRepository;
    const failed = (cause: unknown) =>
      new McpProjectsError({ message: "Не удалось получить проект.", cause });
    return McpManagerProjects.of({
      getCwd: (projectId) =>
        projectRepo.getById({ projectId: ProjectId.make(projectId) }).pipe(
          Effect.map((option) => {
            const project = Option.getOrNull(option);
            return project !== null && project.deletedAt === null ? project.workspaceRoot : null;
          }),
          Effect.mapError(failed),
        ),
    });
  }),
);

/** Dispatch forwards to the host engine (readable detail preserved on `message`); the
 * domain-event stream is narrowed to `{type, projectId?}` — exactly what the package
 * reactor/query filter on. */
export const mcpEngineLayer = Layer.effect(
  McpManagerEngine,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return McpManagerEngine.of({
      dispatch: (command) =>
        engine.dispatch(command).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new McpEngineError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          ),
        ),
      domainEvents: engine.streamDomainEvents.pipe(
        Stream.map((event): McpManagerDomainEvent => {
          const projectId =
            typeof event.payload === "object" &&
            event.payload !== null &&
            "projectId" in event.payload &&
            typeof event.payload.projectId === "string"
              ? ProjectId.make(event.payload.projectId)
              : undefined;
          return { type: event.type, ...(projectId !== undefined ? { projectId } : {}) };
        }),
      ),
    });
  }),
);

/**
 * The full MCP manager runtime (supervisor / reactor / overlay / runtime / query /
 * session-overlay gate / repos) with every host port provided. Requires ambiently:
 * SqlClient, FileSystem, Path, ServerConfig, ServerSecretStore, ServerSettingsService,
 * OrchestrationEngineService — all present where server.ts composes the runtime graph.
 */
export const McpManagerHostLayer = McpRuntimeServicesLive.pipe(
  Layer.provide(mcpConfigLayer),
  Layer.provide(mcpSecretStoreLayer),
  Layer.provide(mcpSettingsLayer),
  Layer.provide(mcpProjectsLayer.pipe(Layer.provide(ProjectionProjectRepositoryLive))),
  Layer.provide(mcpEngineLayer),
);

// ── test/no-op layers (integration harnesses that don't exercise MCP) ─────────

/** Map-backed secret store — for harnesses whose decider never splits real secrets. */
export const McpManagerSecretStoreMemory = Layer.sync(McpManagerSecretStore, () => {
  const store = new Map<string, Uint8Array>();
  return McpManagerSecretStore.of({
    get: (name) => Effect.sync(() => store.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    pruneByPrefix: (prefix, keep) =>
      Effect.sync(() => {
        for (const name of store.keys()) {
          if (name.startsWith(prefix) && !keep.has(name)) {
            store.delete(name);
          }
        }
      }),
  });
});

/** No-op session-overlay gate — spawn paths behave exactly as a no-MCP app. */
export const McpSessionOverlayNoop = Layer.succeed(
  McpSessionOverlay,
  McpSessionOverlay.of({
    resolveForTurn: () => Effect.succeed(null),
    writeForSpawn: () => Effect.succeed(null),
    changedForThread: () => Effect.succeed(false),
    spawnState: () => Effect.undefined,
    recordSpawn: () => Effect.void,
    deleteOverlayFile: () => Effect.void,
  }),
);
