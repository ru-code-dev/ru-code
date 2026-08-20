// ru-code: characterization tests for the built-in/custom server LIFECYCLE through the REAL engine
// (decider → event → SQL projection → command-receipt store). These exercise the path where the
// reactor's reconciliation meets the engine's commandId-receipt dedup — i.e. where "remove then
// re-add" lives. Some of these are written to the CORRECT expected behaviour and currently FAIL;
// the failure IS the spec for the reconciliation bug (a stable/content commandId is deduped forever).

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  backfillServerMetadataEffect,
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  configCacheKey,
  McpBindingRepository,
  McpCatalogRepository,
  McpProbeCacheRepository,
  McpServerId,
  pruneOrphanedVarValuesEffect,
  reconcileBuiltinsWith,
  type McpBinding,
  type McpBuiltinDefinition,
  type McpCatalogServer,
  type McpProbeRecord,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, IsoDateTime, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

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
import { mcpEngineLayer, mcpSecretStoreLayer } from "../../mcp/mcpPorts.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";

const DEMO: McpBuiltinDefinition = {
  builtinId: "demo",
  name: "demo",
  description: "Demo",
  config: { default: { transport: "stdio", command: "uvx", args: ["demo"] } },
  vars: [{ name: "URL", secret: false, perProject: false, required: true, value: "https://demo" }],
};

/** The mcp.builtin-sync command the reactor dispatches for `definition` (commandId is the reactor's). */
function syncCommand(definition: McpBuiltinDefinition, commandId: string): OrchestrationCommand {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- ru-code: mirrors production (McpReactor passes process.platform to the builtin migrator); injecting HostProcessPlatform would diverge the ported suite
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

function removeCommand(serverId: string, commandId: string): OrchestrationCommand {
  return {
    type: "mcp.server-remove",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
  };
}

function addCustomCommand(serverId: string, name: string, commandId: string): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    draft: {
      name,
      config: { transport: "stdio", command: "uvx", args: [name] },
      vars: [],
      timeoutMs: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function projectCreateCommand(projectId: string, commandId: string): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    title: "Test project",
    workspaceRoot: `/tmp/${projectId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function bindCommand(projectId: string, serverId: string, commandId: string): OrchestrationCommand {
  return {
    type: "mcp.binding-set",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    serverId: McpServerId.make(serverId),
    patch: { enabled: true },
  };
}

function updateCustomConfigCommand(
  serverId: string,
  args: ReadonlyArray<string>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: { config: { transport: "stdio", command: "uvx", args: [...args] } },
  };
}

function addCustomWithVarCommand(
  serverId: string,
  name: string,
  varName: string,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    draft: {
      name,
      config: { transport: "stdio", command: "uvx", args: [name] },
      vars: [{ name: varName, secret: false, perProject: true, required: false, value: null }],
      timeoutMs: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function setServerVarsCommand(
  serverId: string,
  varNames: ReadonlyArray<string>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: {
      vars: varNames.map((name) => ({
        name,
        secret: false,
        perProject: true,
        required: false,
        value: null,
      })),
    },
  };
}

function bindVarsCommand(
  projectId: string,
  serverId: string,
  varValues: Record<string, string>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.binding-set",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    serverId: McpServerId.make(serverId),
    patch: { enabled: true, varValues },
  };
}

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-recon-test-" });
  const engineBase = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    // Merge the pipeline too so its McpCatalogRepository output is queryable from the runtime.
    OrchestrationProjectionPipelineLive,
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
  const layer = mcpEngineLayer.pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(layer);
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (engine) =>
          engine.dispatch(command),
        ),
      ),
    catalog: (): Promise<ReadonlyArray<McpCatalogServer>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpCatalogRepository), (repo) => repo.listAll()),
      ),
    bindings: (): Promise<ReadonlyArray<McpBinding>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpBindingRepository), (repo) => repo.listAll()),
      ),
    // Drive the REAL reactor reconcile loop with a given shipped-definition list (the testability seam).
    reconcile: (definitions: ReadonlyArray<McpBuiltinDefinition>) =>
      // oxlint-disable-next-line t3code/no-global-process-runtime -- ru-code: mirrors production (McpReactor passes process.platform to the builtin migrator); injecting HostProcessPlatform would diverge the ported suite
      runtime.runPromise(reconcileBuiltinsWith(definitions, process.platform)),
    prune: () => runtime.runPromise(pruneOrphanedVarValuesEffect),
    backfill: () => runtime.runPromise(backfillServerMetadataEffect),
    probeUpsert: (record: McpProbeRecord) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpProbeCacheRepository), (repo) => repo.upsert(record)),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("server lifecycle through the engine (reconciliation characterization)", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("a no-op re-sync (same commandId) does not duplicate the server", async () => {
    await system.dispatch(syncCommand(DEMO, "sync:demo:v1"));
    await system.dispatch(syncCommand(DEMO, "sync:demo:v1")); // identical → deduped, correctly
    const catalog = await system.catalog();
    expect(catalog.filter((server) => server.builtinId === "demo")).toHaveLength(1);
  });

  it("a CHANGED built-in definition propagates to an existing install (update applies)", async () => {
    // v1 installed (commandId carries v1's hash, as the reactor does).
    await system.dispatch(syncCommand(DEMO, "sync:demo:hashA"));
    // v2 changes the command; the reactor would dispatch with a NEW hash-bearing commandId.
    const demoV2: McpBuiltinDefinition = {
      ...DEMO,
      config: { default: { transport: "stdio", command: "uvx", args: ["demo", "--v2"] } },
    };
    await system.dispatch(syncCommand(demoV2, "sync:demo:hashB"));
    const server = (await system.catalog()).find((entry) => entry.builtinId === "demo");
    expect(server?.config).toEqual({ transport: "stdio", command: "uvx", args: ["demo", "--v2"] });
  });

  it("the reactor re-adds a removed built-in on a later reconcile (real reconcile loop)", async () => {
    // Drive the actual reactor reconcile loop, varying the shipped-definition list across "restarts".
    await system.reconcile([DEMO]); // ship it → installed
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(true);

    await system.reconcile([]); // dropped from the shipped list → removed
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(false);

    await system.reconcile([DEMO]); // shipped again → MUST reappear
    // EXPECTED: it's back. Currently FAILS — the reconcile re-dispatches the SAME content-stable
    // commandId from the first install, which the engine's accepted-receipt short-circuits, so the
    // re-add never happens. This goes green once the reactor emits a fresh per-reconcile commandId.
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(true);
  });

  it("removing a built-in TWICE removes it both times (remove id is not one-shot)", async () => {
    // Re-install between the two removals uses DIFFERENT content (new hash ⇒ new SYNC commandId), so
    // this test isolates the REMOVE-side dedup from the re-add bug — the re-install genuinely succeeds.
    const demoV2: McpBuiltinDefinition = {
      ...DEMO,
      config: { default: { transport: "stdio", command: "uvx", args: ["demo", "--v2"] } },
    };
    await system.reconcile([DEMO]);
    await system.reconcile([]); // removal #1 (commandId server:mcp-builtin-remove:demo)
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(false);

    await system.reconcile([demoV2]); // re-install with new content ⇒ NOT blocked by the re-add dedup
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(true);

    await system.reconcile([]); // removal #2 — SAME remove commandId ⇒ must still remove
    // EXPECTED gone. FAILS today: the second removal re-uses `server:mcp-builtin-remove:demo`, which the
    // engine's accepted-receipt short-circuits, so demo is stranded. Needs a per-reconcile id on REMOVE.
    expect((await system.catalog()).some((server) => server.builtinId === "demo")).toBe(false);
  });

  it("two custom servers with the SAME name but DIFFERENT config both appear (name is not the identity)", async () => {
    // ru-code #2: identity is the CONFIG, not the name. Same name is fine as long as the config differs;
    // a same-CONFIG add is rejected (covered in branch3DeciderGuards).
    await system.dispatch(addCustomCommand("srv-a", "foo", "add:a")); // config: uvx foo
    await system.dispatch({
      type: "mcp.server-add",
      commandId: CommandId.make("add:b"),
      serverId: McpServerId.make("srv-b"),
      draft: {
        name: "foo",
        config: { transport: "stdio", command: "uvx", args: ["foo", "--b"] },
        vars: [],
        timeoutMs: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const named = (await system.catalog()).filter((server) => server.name === "foo");
    expect(named).toHaveLength(2);
  });
});

describe("custom (UI-added) servers + project cascade", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("a custom server's command edit is reflected in the catalog (the binding reads it)", async () => {
    await system.dispatch(addCustomCommand("srv-c", "myc", "add:c"));
    await system.dispatch(updateCustomConfigCommand("srv-c", ["myc", "--new"], "upd:c"));
    const server = (await system.catalog()).find((entry) => entry.id === "srv-c");
    expect(server?.config).toEqual({ transport: "stdio", command: "uvx", args: ["myc", "--new"] });
  });

  it("removing a CUSTOM server used by a project leaves no binding behind", async () => {
    await system.dispatch(projectCreateCommand("proj-1", "pc:1"));
    await system.dispatch(addCustomCommand("srv-d", "myd", "add:d"));
    await system.dispatch(bindCommand("proj-1", "srv-d", "bind:d"));
    expect((await system.bindings()).some((binding) => binding.serverId === "srv-d")).toBe(true);

    await system.dispatch(removeCommand("srv-d", "rm:d"));
    expect((await system.catalog()).some((entry) => entry.id === "srv-d")).toBe(false);
    expect((await system.bindings()).some((binding) => binding.serverId === "srv-d")).toBe(false);
  });

  it("removing a BUILT-IN used by a project leaves no binding behind", async () => {
    await system.dispatch(projectCreateCommand("proj-2", "pc:2"));
    await system.dispatch(syncCommand(DEMO, "sync:demo:v1"));
    const demoId = builtinServerId("demo");
    await system.dispatch(bindCommand("proj-2", demoId, "bind:demo"));
    expect((await system.bindings()).some((binding) => binding.serverId === demoId)).toBe(true);

    await system.dispatch(removeCommand(demoId, "rm:demo"));
    expect((await system.bindings()).some((binding) => binding.serverId === demoId)).toBe(false);
  });
});

describe("reconciler hygiene commands must re-run on later state changes (dedup characterization)", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  const bindingVarKeys = async (serverId: string): Promise<ReadonlyArray<string>> => {
    const binding = (await system.bindings()).find((entry) => entry.serverId === serverId);
    return binding ? Object.keys(binding.varValues) : [];
  };

  it("prune-orphaned-var-values runs AGAIN when a new orphan appears for the same binding", async () => {
    await system.dispatch(projectCreateCommand("proj-pr", "pc:pr"));
    await system.dispatch(addCustomWithVarCommand("srv-pr", "psrv", "V", "add:pr"));
    await system.dispatch(bindVarsCommand("proj-pr", "srv-pr", { V: "x" }, "bind:pr1"));
    await system.dispatch(setServerVarsCommand("srv-pr", [], "rm-v")); // remove V ⇒ V is orphaned

    await system.prune(); // first prune drops the orphaned V
    expect(await bindingVarKeys("srv-pr")).not.toContain("V");

    // Now create a NEW orphan (W) on the SAME (project, server) binding.
    await system.dispatch(setServerVarsCommand("srv-pr", ["W"], "add-w")); // declare W
    await system.dispatch(bindVarsCommand("proj-pr", "srv-pr", { W: "y" }, "bind:pr2"));
    await system.dispatch(setServerVarsCommand("srv-pr", [], "rm-w")); // remove W ⇒ W is orphaned

    await system.prune(); // second prune re-uses commandId server:mcp-prune-vars:proj-pr:srv-pr
    // EXPECTED: W pruned. FAILS today — the stable commandId is short-circuited by the accepted
    // receipt from the first prune, so the orphan W is stranded in the binding's varValues.
    expect(await bindingVarKeys("srv-pr")).not.toContain("W");
  });

  it("meta-backfill runs AGAIN after the description is cleared and re-probed", async () => {
    const description = (serverId: string) =>
      system
        .catalog()
        .then((catalog) => catalog.find((entry) => entry.id === serverId)?.description);
    // A custom server "mb" → config args ["mb"]; compute its probe-cache key the same way the reactor does.
    const configKey = configCacheKey(
      { transport: "stdio", command: "uvx", args: ["mb"] },
      [],
      {},
      [],
      {},
    );
    await system.dispatch(addCustomCommand("srv-mb", "mb", "add:mb")); // custom add ⇒ description null
    await system.probeUpsert({
      configKey,
      transport: "stdio",
      status: "online",
      tools: [],
      lastError: null,
      serverDescription: "Probed description",
      serverWebsiteUrl: null,
      checkedAt: IsoDateTime.make("2026-06-07T10:00:00.000Z"),
      checkedAtMs: 1_780_000_000_000,
    });

    await system.backfill(); // fills the empty description from the cached probe
    expect(await description("srv-mb")).toBe("Probed description");

    // User clears the description; the probe still reports one.
    await system.dispatch({
      type: "mcp.server-update",
      commandId: CommandId.make("clear-desc"),
      serverId: McpServerId.make("srv-mb"),
      patch: { description: null },
    });
    expect(await description("srv-mb")).toBeNull();

    await system.backfill(); // second backfill re-uses commandId server:mcp-meta-backfill:srv-mb:description
    // EXPECTED: re-filled. FAILS today — the stable commandId is short-circuited by the accepted
    // receipt from the first backfill, so the description stays empty.
    expect(await description("srv-mb")).toBe("Probed description");
  });
});

describe("decider guards reject invalid commands", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("rejects adding a server with a duplicate id (no second row)", async () => {
    await system.dispatch(addCustomCommand("dup", "foo", "add:1"));
    await expect(system.dispatch(addCustomCommand("dup", "foo", "add:2"))).rejects.toThrow();
    expect((await system.catalog()).filter((entry) => entry.id === "dup")).toHaveLength(1);
  });

  it("rejects a config patch on a LOCKED built-in template (command unchanged)", async () => {
    await system.dispatch(syncCommand(DEMO, "sync:demo:1")); // locked built-in
    await expect(
      system.dispatch(updateCustomConfigCommand(builtinServerId("demo"), ["evil"], "upd:evil")),
    ).rejects.toThrow();
    const demo = (await system.catalog()).find((entry) => entry.builtinId === "demo");
    expect(demo?.config).toEqual({ transport: "stdio", command: "uvx", args: ["demo"] });
  });

  it("rejects a binding-set for a missing project", async () => {
    await system.dispatch(addCustomCommand("srv-mp", "mp", "add:mp"));
    await expect(
      system.dispatch(bindCommand("ghost-project", "srv-mp", "bind:g1")),
    ).rejects.toThrow();
  });

  it("rejects a binding-set for a missing server", async () => {
    await system.dispatch(projectCreateCommand("proj-ms", "pc:ms"));
    await expect(
      system.dispatch(bindCommand("proj-ms", "ghost-server", "bind:g2")),
    ).rejects.toThrow();
  });

  it("rejects removing a server that does not exist", async () => {
    await expect(system.dispatch(removeCommand("nope", "rm:nope"))).rejects.toThrow();
  });
});
