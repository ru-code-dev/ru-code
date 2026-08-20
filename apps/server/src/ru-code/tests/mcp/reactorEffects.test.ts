// ru-code: behavior tests for the reactor's extracted effects driven against the REAL engine —
// computeDesired (which servers get probed: enabled/incomplete gating + dedup-by-resolved-hash +
// refcounting), gcOrphanedSecrets (prune secret .bin files no longer referenced), and autobind
// (bind built-ins to a new project when the setting is on). These cover the runtime decisions that
// decide what qwen/the monitor actually act on.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  autobindBuiltinsForProjectWith,
  builtinConfigForPlatform,
  builtinHash,
  builtinServerId,
  builtinShippedVars,
  computeDesiredEffect,
  gcOrphanedSecretsEffect,
  McpBindingRepository,
  McpServerId,
  mcpVarSecretName,
  readMcpSecret,
  type McpBuiltinDefinition,
  type McpServerVarDraft,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
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
import { ServerSettingsService } from "../../../serverSettings.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import {
  mcpConfigLayer,
  mcpEngineLayer,
  mcpSecretStoreLayer,
  mcpSettingsLayer,
} from "../../mcp/mcpPorts.ts";

const ISO = "2026-01-01T00:00:00.000Z";

const DEMO: McpBuiltinDefinition = {
  builtinId: "demo",
  name: "demo",
  config: { default: { transport: "stdio", command: "uvx", args: ["demo"] } },
  vars: [],
};

function projectCreate(projectId: string, cmd: string): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.make(cmd),
    projectId: ProjectId.make(projectId),
    title: "P",
    workspaceRoot: `/w/${projectId}`,
    createdAt: ISO,
  };
}
function addStdio(
  serverId: string,
  args: ReadonlyArray<string>,
  vars: ReadonlyArray<McpServerVarDraft>,
  cmd: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(cmd),
    serverId: McpServerId.make(serverId),
    draft: {
      name: serverId,
      config: { transport: "stdio", command: "uvx", args: [...args] },
      vars,
      timeoutMs: null,
    },
    createdAt: ISO,
  };
}
function setEnabled(serverId: string, enabled: boolean, cmd: string): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(cmd),
    serverId: McpServerId.make(serverId),
    patch: { enabled },
  };
}
function remove(serverId: string, cmd: string): OrchestrationCommand {
  return {
    type: "mcp.server-remove",
    commandId: CommandId.make(cmd),
    serverId: McpServerId.make(serverId),
  };
}
function bind(
  projectId: string,
  serverId: string,
  varValues: Record<string, string>,
  cmd: string,
): OrchestrationCommand {
  return {
    type: "mcp.binding-set",
    commandId: CommandId.make(cmd),
    projectId: ProjectId.make(projectId),
    serverId: McpServerId.make(serverId),
    patch: { enabled: true, varValues },
  };
}
function syncBuiltin(definition: McpBuiltinDefinition, cmd: string): OrchestrationCommand {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- ru-code: mirrors production (McpReactor passes process.platform to the builtin migrator); injecting HostProcessPlatform would diverge the ported suite
  const config = builtinConfigForPlatform(definition, process.platform)!;
  return {
    type: "mcp.builtin-sync",
    commandId: CommandId.make(cmd),
    serverId: McpServerId.make(builtinServerId(definition.builtinId)),
    builtinId: definition.builtinId,
    builtinHash: builtinHash(config, definition),
    name: definition.name,
    description: null,
    websiteUrl: null,
    config,
    shippedVars: builtinShippedVars(definition),
    timeoutMs: null,
  };
}

function makeSystem(autobindDefaults: boolean) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-reactor-test-",
  });
  const engineBase = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
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
  const layer = Layer.mergeAll(mcpConfigLayer, mcpEngineLayer, mcpSettingsLayer).pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest({ mcp: { autobindDefaults } })),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(layer);
  return {
    dispatch: (c: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (e) => e.dispatch(c)),
      ),
    computeDesired: () => runtime.runPromise(computeDesiredEffect),
    gc: () => runtime.runPromise(gcOrphanedSecretsEffect),
    autobind: (projectId: string) =>
      runtime.runPromise(autobindBuiltinsForProjectWith(ProjectId.make(projectId))),
    bindings: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpBindingRepository), (r) => r.listAll())),
    secretGet: (ref: string) =>
      // Read through the PACKAGE cipher helper — the same round-trip the package's
      // secret-reading effects take; the raw store/port would return ciphertext.
      runtime.runPromise(readMcpSecret(ref)),
    dispose: () => runtime.dispose(),
  };
}

describe("computeDesiredEffect — probe-target selection", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem(false);
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("a no-override binding merges into its catalog instance (one instance, two refs)", async () => {
    await system.dispatch(projectCreate("p1", "pc1"));
    await system.dispatch(addStdio("s", [], [], "add:s"));
    await system.dispatch(bind("p1", "s", {}, "bind:s"));

    const desired = await system.computeDesired();
    const inst = [...desired.values()].find((i) => i.refs.has("catalog:s"));
    expect(inst).toBeDefined();
    expect(inst?.refs.has("p1:s")).toBe(true); // same resolved config ⇒ deduped onto the catalog instance
  });

  it("excludes a catalog-disabled server and an incomplete binding", async () => {
    await system.dispatch(addStdio("s-dis", [], [], "add:dis"));
    await system.dispatch(setEnabled("s-dis", false, "dis"));
    await system.dispatch(
      addStdio(
        "s-inc",
        ["${NEED}"],
        [{ name: "NEED", secret: false, perProject: true, required: true, value: null }],
        "add:inc",
      ),
    );
    const desired = await system.computeDesired();
    const allRefs = [...desired.values()].flatMap((i) => Array.from(i.refs));
    expect(allRefs.some((r) => r.includes("s-dis"))).toBe(false);
    expect(allRefs.some((r) => r.includes("s-inc"))).toBe(false);
  });

  it("two bindings with DIFFERENT per-project values are two instances; SAME value collapses to one", async () => {
    await system.dispatch(projectCreate("pa", "pca"));
    await system.dispatch(projectCreate("pb", "pcb"));
    // server whose resolved config depends on a required per-project var ⇒ catalog default is incomplete.
    await system.dispatch(
      addStdio(
        "s-v",
        ["${ARG}"],
        [{ name: "ARG", secret: false, perProject: true, required: true, value: null }],
        "add:v",
      ),
    );
    await system.dispatch(bind("pa", "s-v", { ARG: "x" }, "bind:a"));
    await system.dispatch(bind("pb", "s-v", { ARG: "y" }, "bind:b"));
    const twoVals = [...(await system.computeDesired()).values()].filter((i) =>
      [...i.refs].some((r) => r.endsWith(":s-v")),
    );
    expect(twoVals).toHaveLength(2); // different resolved configs ⇒ separate instances

    await system.dispatch(bind("pb", "s-v", { ARG: "x" }, "bind:b2")); // now same as pa
    const oneVal = [...(await system.computeDesired()).values()].filter((i) =>
      [...i.refs].some((r) => r.endsWith(":s-v")),
    );
    expect(oneVal).toHaveLength(1);
    expect(oneVal[0]?.refs.has("pa:s-v")).toBe(true);
    expect(oneVal[0]?.refs.has("pb:s-v")).toBe(true);
  });
});

describe("gcOrphanedSecretsEffect — secret GC", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem(false);
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("prunes a secret no longer referenced, keeps a live one", async () => {
    const secretVar: McpServerVarDraft = {
      name: "TOK",
      secret: true,
      perProject: false,
      required: false,
      value: "v",
    };
    // ru-code #2: distinct configs (identity is the config) — args differ so both servers can be added.
    await system.dispatch(addStdio("s-live", ["live"], [secretVar], "add:live"));
    await system.dispatch(addStdio("s-dead", ["dead"], [secretVar], "add:dead"));
    const liveRef = mcpVarSecretName({ serverId: "s-live", varName: "TOK" });
    const deadRef = mcpVarSecretName({ serverId: "s-dead", varName: "TOK" });
    expect(await system.secretGet(liveRef)).not.toBeNull();
    expect(await system.secretGet(deadRef)).not.toBeNull();

    await system.dispatch(remove("s-dead", "rm:dead")); // s-dead's secret is now orphaned
    await system.gc();

    expect(await system.secretGet(liveRef)).not.toBeNull(); // still referenced ⇒ kept
    expect(await system.secretGet(deadRef)).toBeNull(); // orphaned ⇒ pruned
  });
});

describe("autobindBuiltinsForProjectWith — default bindings", () => {
  let system: ReturnType<typeof makeSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("binds every catalog built-in to the project when autobindDefaults is ON", async () => {
    system = makeSystem(true);
    await system.dispatch(syncBuiltin(DEMO, "sync"));
    await system.dispatch(projectCreate("pab", "pcab"));
    await system.autobind("pab");
    expect(
      (await system.bindings()).some(
        (b) => b.projectId === "pab" && b.serverId === builtinServerId("demo"),
      ),
    ).toBe(true);
  });

  it("binds NOTHING when autobindDefaults is OFF", async () => {
    system = makeSystem(false);
    await system.dispatch(syncBuiltin(DEMO, "sync"));
    await system.dispatch(projectCreate("pab2", "pcab2"));
    await system.autobind("pab2");
    expect((await system.bindings()).filter((b) => b.projectId === "pab2")).toHaveLength(0);
  });
});
