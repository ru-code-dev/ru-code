// ru-code: behavior test for McpRuntime.currentSnapshot — the UI runtime projection that joins the
// supervisor's live instances to the catalog + bindings. Populates catalog/bindings via the real
// engine, computes the desired instances (configKeys aligned), seeds a probe-cache row so the instance
// hydrates "online", reconciles the supervisor, then reads the runtime snapshot (via the stream head)
// and asserts the per-binding + per-catalog runtime status/tools the UI will show.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  computeDesiredEffect,
  McpProbeCacheRepository,
  McpRuntime,
  McpRuntimeLive,
  McpServerId,
  McpSupervisor,
  McpSupervisorLive,
  type DesiredInstance,
  type McpProbeRecord,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, IsoDateTime, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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
const projectCreate = (p: string, c: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make(c),
  projectId: ProjectId.make(p),
  title: "P",
  workspaceRoot: `/w/${p}`,
  createdAt: ISO,
});
const add = (s: string, c: string): OrchestrationCommand => ({
  type: "mcp.server-add",
  commandId: CommandId.make(c),
  serverId: McpServerId.make(s),
  draft: {
    name: s,
    config: { transport: "stdio", command: "uvx", args: [s] },
    vars: [],
    timeoutMs: null,
  },
  createdAt: ISO,
});
const bind = (p: string, s: string, c: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(c),
  projectId: ProjectId.make(p),
  serverId: McpServerId.make(s),
  patch: { enabled: true },
});

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-runtime-test-",
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
  const base = Layer.mergeAll(mcpConfigLayer, mcpEngineLayer, mcpSettingsLayer).pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );
  const withSupervisor = McpSupervisorLive.pipe(Layer.provideMerge(base));
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(McpRuntimeLive.pipe(Layer.provideMerge(withSupervisor)));
  return {
    dispatch: (c: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (e) => e.dispatch(c)),
      ),
    computeDesired: (): Promise<Map<string, DesiredInstance>> =>
      runtime.runPromise(computeDesiredEffect),
    reconcileSupervisor: (d: Map<string, DesiredInstance>) =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), (s) => s.reconcile(d))),
    seed: (record: McpProbeRecord) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpProbeCacheRepository), (r) => r.upsert(record)),
      ),
    snapshot: () =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpRuntime), (rt) =>
          Stream.runHead(rt.subscriptionStream).pipe(Effect.map((o) => Option.getOrThrow(o))),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("McpRuntime.currentSnapshot — UI runtime projection", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("joins a probed instance to its binding + catalog default (status + tools)", async () => {
    await system.dispatch(projectCreate("p1", "pc1"));
    await system.dispatch(add("s1", "add:s1"));
    await system.dispatch(bind("p1", "s1", "bind:1"));

    const desired = await system.computeDesired();
    const configKey = [...desired.values()][0]!.configKey;

    // Seed a cached probe row BEFORE reconcile so the instance hydrates "online".
    await system.seed({
      configKey,
      transport: "stdio",
      status: "online",
      tools: [{ name: "do_thing", description: "Does a thing" }],
      lastError: null,
      serverDescription: null,
      serverWebsiteUrl: null,
      checkedAt: IsoDateTime.make("2026-06-07T10:00:00.000Z"),
      checkedAtMs: 1_780_000_000_000,
    });
    await system.reconcileSupervisor(desired);

    const snap = await system.snapshot();

    // Per-catalog runtime: s1 online with the discovered tool.
    const cat = snap.catalogRuntimes.find((c) => c.serverId === "s1");
    expect(cat?.status).toBe("online");
    expect(cat?.discoveredTools.map((t) => t.name)).toEqual(["do_thing"]);

    // Per-binding runtime: p1→s1 online (same deduped instance).
    const rt = snap.runtimes.find((r) => r.projectId === "p1" && r.serverId === "s1");
    expect(rt?.status).toBe("online");
    expect(rt?.discoveredTools.map((t) => t.name)).toEqual(["do_thing"]);
  });

  it("shows no runtime for a server that was never probed/reconciled", async () => {
    await system.dispatch(add("s-unp", "add:unp"));
    const snap = await system.snapshot();
    expect(snap.catalogRuntimes.some((c) => c.serverId === "s-unp")).toBe(false);
  });
});
