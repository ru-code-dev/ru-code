// @effect-diagnostics nodeBuiltinImport:off
// ru-code: improvements-branch-3 #1 — RED test for the description/docs back-fill ORDERING bug.
// On a fresh add, `backfillServerMetadata` runs (inside reconcileNow) BEFORE `probeHashes`, so the
// probe cache is still empty when the back-fill looks — the catalog description is never filled that
// cycle (it only fills after a restart). This drives the WHOLE reactor against a fake stdio server
// that reports a serverInfo.description, waits for the probe to capture it, then asserts the catalog
// was back-filled in the same session. RED today; green once the back-fill runs AFTER the probe.
// No production logic touched (uses the reactor's public start()/engine + a description-reporting fixture).

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  configCacheKey,
  McpCatalogRepository,
  McpOverlayLive,
  McpProbeCacheRepository,
  McpReactor,
  McpReactorLive,
  McpServerId,
  McpSupervisorLive,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { layer as ServerSecretStoreLayer } from "../../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import {
  mcpConfigLayer,
  mcpEngineLayer,
  mcpProjectsLayer,
  mcpSecretStoreLayer,
  mcpSettingsLayer,
} from "../../mcp/mcpPorts.ts";

const FAKE_DESC_SERVER = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../fixtures/fakeMcpStdioServerWithDescription.mjs",
);

const addDescServer = (serverId: string): OrchestrationCommand => ({
  type: "mcp.server-add",
  commandId: CommandId.make(`cmd-add-${serverId}`),
  serverId: McpServerId.make(serverId),
  draft: {
    name: serverId,
    config: { transport: "stdio", command: "node", args: [FAKE_DESC_SERVER] },
    vars: [],
    timeoutMs: 10_000,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
});

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-branch3-bf-" });
  const engineBase = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionPipelineLive,
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    // ru-code: the engine decider reads the McpManagerSecretStore port (real host adapter).
    Layer.provideMerge(mcpSecretStoreLayer),
  );
  const base = Layer.mergeAll(
    mcpConfigLayer,
    mcpEngineLayer,
    mcpProjectsLayer,
    mcpSettingsLayer,
  ).pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
  );
  const withSupervisor = McpSupervisorLive.pipe(Layer.provideMerge(base));
  const withOverlay = McpOverlayLive.pipe(Layer.provideMerge(withSupervisor));
  const reactorLayer = McpReactorLive.pipe(Layer.provideMerge(withOverlay));
  // ru-code: the harness services the scoped body may reach (typed, so no unsafe casts — these
  // suites typecheck in ng, unlike the transpile-only legacy tests dir).
  type SystemServices = Layer.Success<typeof reactorLayer>;
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(reactorLayer);
  return {
    run: <A, E>(body: Effect.Effect<A, E, SystemServices | Scope.Scope>): Promise<A> =>
      runtime.runPromise(Effect.scoped(body)),
    dispose: () => runtime.dispose(),
  };
}

const waitUntil = <A, E>(query: Effect.Effect<A, E>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const value = yield* query;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(new Error("waitUntil: condition not satisfied within timeout"));
  });

describe("branch-3 #1 — description back-fill runs AFTER the probe", () => {
  let system: ReturnType<typeof makeSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("fills the catalog description from the probe in the SAME session (RED)", async () => {
    system = makeSystem();
    const configKey = configCacheKey(
      { transport: "stdio", command: "node", args: [FAKE_DESC_SERVER] },
      [],
      {},
      [],
      {},
    );
    const description = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        yield* reactor.start();
        const engine = yield* OrchestrationEngineService;
        const probeCache = yield* McpProbeCacheRepository;
        const catalogRepository = yield* McpCatalogRepository;
        yield* engine.dispatch(addDescServer("desc"));
        // Wait until the probe has actually captured the server's reported description into the cache.
        yield* waitUntil(
          probeCache.getByKey({ configKey }),
          (cached) =>
            Option.isSome(cached) && cached.value.serverDescription === "Probed description",
        );
        const catalog = yield* catalogRepository.listAll();
        return catalog.find((server) => server.id === "desc")?.description ?? null;
      }),
    );
    // RED today: the probe captured the description, but the back-fill ran BEFORE the probe, so the
    // catalog field is still null this session. The fix runs the back-fill after probeHashes.
    expect(description).toBe("Probed description");
  }, 30_000);
});
