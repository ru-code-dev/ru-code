// ru-code (S99): a REINSTALL through the real engine + the real overlay. An install holds an older
// release's built-ins and a user server, all bound; the new release's list then keeps one, changes
// one (renamed), drops one and adds one. The startup reconciliation (reconcileBuiltinsWith — by
// builtinId, never by qwen's key) must give the same catalog it always gave, and the overlay qwen
// gets must name every server by its readable key, identical in the file and the allowlist.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  builtinServerId,
  McpBindingRepository,
  McpCatalogRepository,
  McpOverlay,
  McpOverlayLive,
  McpServerId,
  qwenServerKey,
  reconcileBuiltinsWith,
  type McpBuiltinDefinition,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, describe, it } from "@effect/vitest";

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
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import {
  mcpConfigLayer,
  mcpEngineLayer,
  mcpProjectsLayer,
  mcpSecretStoreLayer,
} from "../../mcp/mcpPorts.ts";

/** A built-in with only a `default` config — the same on every platform (so "linux" below). */
const builtin = (builtinId: string, name: string, arg: string): McpBuiltinDefinition => ({
  builtinId,
  name,
  config: { default: { transport: "stdio", command: "uvx", args: [arg] } },
  vars: [],
});

/** The release the install came from, and the one reinstalled over it. */
const OLD_RELEASE = [
  builtin("alpha", "Alpha", "alpha"),
  builtin("beta", "Beta Tools", "beta"),
  builtin("gamma", "Гамма", "gamma"),
];
const NEW_RELEASE = [
  builtin("alpha", "Alpha", "alpha"), // unchanged
  builtin("beta", "Beta Tools Pro", "beta-2"), // changed (renamed, new args)
  builtin("delta", "Delta", "delta"), // added; gamma is dropped
];

const ISO = "2026-01-01T00:00:00.000Z";

const projectCreate = (projectId: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make(`pc:${projectId}`),
  projectId: ProjectId.make(projectId),
  title: "P",
  workspaceRoot: `/work/${projectId}`,
  createdAt: ISO,
});

const addUserServer = (serverId: string, name: string): OrchestrationCommand => ({
  type: "mcp.server-add",
  commandId: CommandId.make(`add:${serverId}`),
  serverId: McpServerId.make(serverId),
  draft: {
    name,
    config: { transport: "stdio", command: "uvx", args: [serverId] },
    vars: [],
    timeoutMs: null,
  },
  createdAt: ISO,
});

const bind = (projectId: string, serverId: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(`bind:${projectId}:${serverId}`),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true },
});

const makeTestLayer = () => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-reinstall-test-",
  });
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
  const base = Layer.mergeAll(mcpConfigLayer, mcpEngineLayer, mcpProjectsLayer).pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return McpOverlayLive.pipe(Layer.provideMerge(base));
};

/** The overlay's allowlist and file keys — asserted identical — for `projectId`. */
const qwenNames = (projectId: string) =>
  Effect.gen(function* () {
    const overlay = yield* Effect.service(McpOverlay);
    const resolution = yield* overlay.resolveOverlay(ProjectId.make(projectId));
    // @effect-diagnostics-next-line preferSchemaOverJson:off - test-only read of the would-be file.
    const file = JSON.parse(resolution.contents) as { mcpServers: Record<string, unknown> };
    assert.deepStrictEqual(
      [...resolution.allowedServerNames].toSorted(),
      Object.keys(file.mcpServers).toSorted(),
    );
    return [...resolution.allowedServerNames].toSorted();
  });

describe("reinstall — built-ins reconciled by builtinId, qwen's keys readable and consistent", () => {
  it.effect(
    "an older release's built-ins + a user server, then a built-in kept / changed / dropped / added",
    () =>
      Effect.gen(function* () {
        const engine = yield* Effect.service(OrchestrationEngineService);
        const catalogRepository = yield* Effect.service(McpCatalogRepository);
        const bindingRepository = yield* Effect.service(McpBindingRepository);

        yield* reconcileBuiltinsWith(OLD_RELEASE, "linux");
        yield* engine.dispatch(projectCreate("p1"));
        yield* engine.dispatch(addUserServer("srv-user", "My Server"));
        for (const serverId of [
          "srv-user",
          builtinServerId("alpha"),
          builtinServerId("beta"),
          builtinServerId("gamma"),
        ]) {
          yield* engine.dispatch(bind("p1", serverId));
        }
        assert.deepStrictEqual(
          yield* qwenNames("p1"),
          [
            qwenServerKey("My Server", "srv-user"),
            qwenServerKey("Alpha", builtinServerId("alpha")),
            qwenServerKey("Beta Tools", builtinServerId("beta")),
            qwenServerKey("Гамма", builtinServerId("gamma")),
          ].toSorted(),
        );

        // the reinstall: the app starts with the new release's list
        yield* reconcileBuiltinsWith(NEW_RELEASE, "linux");

        // reconciliation by builtinId, exactly as before S99: kept, updated, removed, added
        const catalog = yield* catalogRepository.listAll();
        assert.deepStrictEqual(
          catalog
            .filter((server) => server.builtinId !== null)
            .map((server) => `${server.builtinId}:${server.name}`)
            .toSorted(),
          ["alpha:Alpha", "beta:Beta Tools Pro", "delta:Delta"],
        );
        assert.ok(catalog.some((server) => server.id === McpServerId.make("srv-user")));
        assert.deepStrictEqual(
          (yield* bindingRepository.listAll()).map((binding) => binding.serverId).toSorted(),
          ["srv-user", builtinServerId("alpha"), builtinServerId("beta")].toSorted(),
        );

        // qwen's names: the kept + user keys unchanged, the renamed one re-slugged with the SAME
        // suffix (its serverId is stable), the dropped one gone — file and allowlist identical
        const after = yield* qwenNames("p1");
        assert.deepStrictEqual(
          after,
          [
            qwenServerKey("My Server", "srv-user"),
            qwenServerKey("Alpha", builtinServerId("alpha")),
            qwenServerKey("Beta Tools Pro", builtinServerId("beta")),
          ].toSorted(),
        );
        assert.include(
          after,
          `beta_tools_pro_${qwenServerKey("Beta Tools", builtinServerId("beta")).slice(-4)}`,
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
