import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePTY from "./terminal/Layers/NodePTY.ts";

import { ServerConfig } from "./config.ts";
import { runFastShutdownCleanup } from "./fastShutdown.ts";
import {
  attachmentsRouteLayer,
  healthRouteLayer,
  pairingStartupRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  shutdownRouteLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
} from "./http.ts";
import { ShutdownSignal } from "./shutdownSignal.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import { OpenLive } from "./open.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import * as GitManager from "./git/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
// ru-fork: filesystem skill scanner Layer (apps/server/src/ru-fork/skills).
import { SkillScannerLive } from "./ru-fork/skills/index.ts";
// ru-fork: filesystem subagent scanner — surfaces cli-code 0.13.1
// built-in agents + ~/<cli-dir>/agents/ + <cwd>/<cli-dir>/agents/ to the composer.
import { SubagentScannerLive } from "./ru-fork/subagents/index.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import {
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
} from "./auth/http.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import * as NetService from "@t3tools/shared/Net";

const PtyAdapterLive = NodePTY.layer;

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
    });
  }),
);

const PlatformServicesLive = NodeServices.layer;

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggersLive` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(GitHubCli.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(TextGeneration.layer),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(VcsStatusBroadcaster.layer.pipe(Layer.provide(GitWorkflowLayerLive))),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const WorkspaceEntriesLayerLive = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const WorkspaceFileSystemLayerLive = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const AuthLayerLive = ServerAuthLive.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  // ru-fork: filesystem skill scanner
  Layer.provideMerge(SkillScannerLive),
  // ru-fork: filesystem subagent scanner
  Layer.provideMerge(SubagentScannerLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  Layer.provideMerge(ProviderEventLoggersLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AuthLayerLive),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provide(NetService.layer),
);

const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

export const makeRoutesLayer = Layer.mergeAll(
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
  attachmentsRouteLayer,
  healthRouteLayer,
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
  pairingStartupRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  shutdownRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
).pipe(Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          });
        }),
        () => clearPersistedServerRuntimeState(config.serverRuntimeStatePath),
      ),
    );

    // SIGINT/SIGTERM fast path. `NodeRuntime.runMain` installs its own
    // SIGINT/SIGTERM listeners (platform-node-shared/NodeRuntime.js:24-25)
    // that call `fiber.interruptUnsafe`, which triggers the slow Layer
    // finalizer chain that the `/shutdown` route is designed to skip.
    // We install OUR listener too — Node delivers every registered
    // listener — so `process.exit(0)` here preempts the slow path.
    //
    // Captures the same Effect runtime the rest of the server uses, so
    // the synchronous Node callback can run `runFastShutdownCleanup`
    // via `Effect.runSync`. Same shared cleanup as `/shutdown`.
    const fastExitLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        // Capture the current Effect Context (services already wired:
        // ProviderService, TerminalManager, ServerConfig) so the
        // synchronous signal callback can run `runFastShutdownCleanup`
        // via `Effect.runSyncWith` without rebuilding a runtime.
        const cleanupCtx = yield* Effect.context<
          ProviderService | TerminalManager | ServerConfig
        >();
        const runCleanupSync = Effect.runSyncWith(cleanupCtx);

        const fastExit = (signal: NodeJS.Signals) => {
          try {
            runCleanupSync(runFastShutdownCleanup);
          } catch {
            // Signal handler must never throw — always reach process.exit.
          } finally {
            process.stderr.write(`\nru-fork received ${signal} — exiting\n`);
            process.exit(0);
          }
        };

        const onSigint = () => fastExit("SIGINT");
        const onSigterm = () => fastExit("SIGTERM");

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.on("SIGINT", onSigint);
            process.on("SIGTERM", onSigterm);
          }),
          () =>
            Effect.sync(() => {
              process.removeListener("SIGINT", onSigint);
              process.removeListener("SIGTERM", onSigterm);
            }),
        );
      }),
    );

    const serverApplicationLayer = Layer.mergeAll(
      // ru-fork: disableListenLog suppresses effect's "Listening on …"
      // startup line; pairing URL log below carries the actionable info.
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
        disableListenLog: true,
      }),
      httpListeningLayer,
      runtimeStateLayer,
      fastExitLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Effect.gen(function* () {
  // Single Deferred shared between the /shutdown route (via the Layer provided
  // into `makeServerLayer`) and the outer race. We can't use a module-level
  // `Layer.effect(ShutdownSignal, …)` here because each materialization would
  // allocate its own Deferred, and the route's `request` would never wake the
  // outer awaiter.
  const deferred = yield* Deferred.make<void>();
  const sharedShutdownSignal = Layer.succeed(ShutdownSignal, {
    request: Deferred.succeed(deferred, undefined).pipe(Effect.asVoid),
    await: Deferred.await(deferred),
  });
  const launchEffect = Layer.launch(makeServerLayer.pipe(Layer.provide(sharedShutdownSignal)));
  const shutdownEffect = Deferred.await(deferred).pipe(
    Effect.tap(() => Effect.logInfo("shutdown requested via /shutdown — releasing server runtime")),
  );
  // raceFirst: whichever settles first wins, the loser is interrupted (which
  // runs the layer's `acquireRelease` finalizers — including the runtime-state
  // file cleanup). If the launch effect fails (port in use, etc.) the failure
  // propagates instead of hanging on `Deferred.await`.
  yield* Effect.raceFirst(launchEffect, shutdownEffect);
}) satisfies Effect.Effect<void, any, ServerConfig>;
