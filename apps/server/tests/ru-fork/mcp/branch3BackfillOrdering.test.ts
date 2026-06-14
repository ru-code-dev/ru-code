// ru-fork: improvements-branch-3 #1 — RED test for the description/docs back-fill ORDERING bug.
// On a fresh add, `backfillServerMetadata` runs (inside reconcileNow) BEFORE `probeHashes`, so the
// probe cache is still empty when the back-fill looks — the catalog description is never filled that
// cycle (it only fills after a restart). This drives the WHOLE reactor against a fake stdio server
// that reports a serverInfo.description, waits for the probe to capture it, then asserts the catalog
// was back-filled in the same session. RED today; green once the back-fill runs AFTER the probe.
// No production logic touched (uses the reactor's public start()/engine + a description-reporting fixture).

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CommandId, McpServerId, type OrchestrationCommand } from "@t3tools/contracts";
import { configCacheKey } from "@ru-fork/mcp-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { McpCatalogRepository } from "../../../src/persistence/Services/McpCatalog.ts";
import { McpProbeCacheRepository } from "../../../src/persistence/Services/McpProbeCache.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../../src/config.ts";
import { ServerSettingsService } from "../../../src/serverSettings.ts";
import { McpOverlayLive } from "../../../src/ru-fork/mcp/McpOverlay.ts";
import { McpReactor, McpReactorLive } from "../../../src/ru-fork/mcp/McpReactor.ts";
import { McpSupervisorLive } from "../../../src/ru-fork/mcp/McpSupervisor.ts";

const FAKE_DESC_SERVER = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../packages/mcp-core/test-fixtures/fakeMcpStdioServerWithDescription.mjs",
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
  const base = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionPipelineLive,
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
  );
  const withSupervisor = McpSupervisorLive.pipe(Layer.provideMerge(base));
  const withOverlay = McpOverlayLive.pipe(Layer.provideMerge(withSupervisor));
  const runtime = ManagedRuntime.make(McpReactorLive.pipe(Layer.provideMerge(withOverlay)));
  return {
    run: <A, R>(body: Effect.Effect<A, never, R | Scope.Scope>): Promise<A> =>
      runtime.runPromise(Effect.scoped(body) as Effect.Effect<A, never, never>),
    dispose: () => runtime.dispose(),
  };
}

const waitUntil = <A>(query: Effect.Effect<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const value = yield* query;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.dieMessage("waitUntil: condition not satisfied within timeout");
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
          (cached) => Option.isSome(cached) && cached.value.serverDescription === "Probed description",
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
