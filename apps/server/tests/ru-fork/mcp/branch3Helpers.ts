// ru-fork: shared harness for the "improvements-branch-3" test suite. Mirrors the makeSystem +
// command builders from reconciliationLifecycle.test.ts so each branch-3 test file can drive the REAL
// decider/engine without re-deriving the layer stack. No production logic here — test scaffolding only.

import {
  CommandId,
  McpServerId,
  ProjectId,
  type McpBinding,
  type McpCatalogServer,
  type McpProbeRecord,
  type McpServerConfig,
  type McpServerVarDraft,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { McpBindingRepository } from "../../../src/persistence/Services/McpBinding.ts";
import { McpCatalogRepository } from "../../../src/persistence/Services/McpCatalog.ts";
import { McpProbeCacheRepository } from "../../../src/persistence/Services/McpProbeCache.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../../src/config.ts";
import { ServerSecretStore } from "../../../src/auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../../../src/auth/Layers/ServerSecretStore.ts";
import { mcpVarSecretName } from "../../../src/ru-fork/mcp/McpSecretNames.ts";
import {
  backfillServerMetadataEffect,
  computeDesiredEffect,
  gcOrphanedSecretsEffect,
  pruneOrphanedVarValuesEffect,
  reconcileBuiltinsWith,
} from "../../../src/ru-fork/mcp/McpReactor.ts";
import {
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  type McpBuiltinDefinition,
} from "../../../src/ru-fork/mcp/McpBuiltins.ts";

const stdio = (args: ReadonlyArray<string>): McpServerConfig => ({
  transport: "stdio",
  command: "uvx",
  args: [...args],
});

export function makeDeciderSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-branch3-test-" });
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionPipelineLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const readRawSecretBytes = (name: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      return yield* fileSystem.readFile(path.join(serverConfig.secretsDir, `${name}.bin`));
    });
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (engine) => engine.dispatch(command)),
      ),
    catalog: (): Promise<ReadonlyArray<McpCatalogServer>> =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpCatalogRepository), (repo) => repo.listAll())),
    bindings: (): Promise<ReadonlyArray<McpBinding>> =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpBindingRepository), (repo) => repo.listAll())),
    reconcile: (definitions: ReadonlyArray<McpBuiltinDefinition>) =>
      runtime.runPromise(reconcileBuiltinsWith(definitions, process.platform)),
    prune: () => runtime.runPromise(pruneOrphanedVarValuesEffect),
    backfill: () => runtime.runPromise(backfillServerMetadataEffect),
    probeUpsert: (record: McpProbeRecord) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpProbeCacheRepository), (repo) => repo.upsert(record)),
      ),
    computeDesired: () => runtime.runPromise(computeDesiredEffect),
    secretSet: (name: string, value: Uint8Array) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore;
          yield* store.set(name, value);
        }),
      ),
    secretRemove: (name: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore;
          yield* store.remove(name);
        }),
      ),
    secretGet: (name: string): Promise<Uint8Array | null> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ServerSecretStore;
          return yield* store.get(name);
        }),
      ),
    gcOrphans: () => runtime.runPromise(gcOrphanedSecretsEffect),
    readRawSecretBytes: (name: string) => runtime.runPromise(readRawSecretBytes(name)),
    mcpVarSecretName,
    dispose: () => runtime.dispose(),
  };
}

// ── command builders ─────────────────────────────────────────────────────────

export function addServerCmd(input: {
  readonly serverId: string;
  readonly name: string;
  readonly args: ReadonlyArray<string>;
  readonly commandId: string;
  readonly vars?: ReadonlyArray<McpServerVarDraft>;
}): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(input.commandId),
    serverId: McpServerId.make(input.serverId),
    draft: {
      name: input.name,
      config: stdio(input.args),
      vars: input.vars ? [...input.vars] : [],
      timeoutMs: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function updateConfigCmd(
  serverId: string,
  args: ReadonlyArray<string>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: { config: stdio(args) },
  };
}

export function setTrustCmd(serverId: string, trust: boolean, commandId: string): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: { trust },
  };
}

export function updateNameCmd(serverId: string, name: string, commandId: string): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: { name },
  };
}

export function projectCreateCmd(projectId: string, commandId: string): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    title: "Test project",
    workspaceRoot: `/tmp/${projectId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function bindWithVarsCmd(input: {
  readonly projectId: string;
  readonly serverId: string;
  readonly varValues: Readonly<Record<string, string>>;
  readonly commandId: string;
}): OrchestrationCommand {
  return {
    type: "mcp.binding-set",
    commandId: CommandId.make(input.commandId),
    projectId: ProjectId.make(input.projectId),
    serverId: McpServerId.make(input.serverId),
    patch: { enabled: true, varValues: { ...input.varValues } },
  };
}

export function builtinDefForArgs(builtinId: string, args: ReadonlyArray<string>): McpBuiltinDefinition {
  return {
    builtinId,
    name: builtinId,
    description: `${builtinId} builtin`,
    config: { default: stdio(args) },
    vars: [],
  };
}

export function syncCmd(definition: McpBuiltinDefinition, commandId: string): OrchestrationCommand {
  const config = builtinConfigForPlatform(definition, process.platform)!;
  return {
    type: "mcp.builtin-sync",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(builtinServerId(definition.builtinId)),
    builtinId: definition.builtinId,
    builtinHash: builtinHash(config, definition),
    name: definition.name,
    description: definition.description ?? null,
    websiteUrl: null,
    config,
    shippedVars: builtinShippedVars(definition),
    timeoutMs: null,
  };
}
