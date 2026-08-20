// ru-code: behavior tests for McpProjectionQuery.getSnapshot — the client-facing catalog+bindings
// snapshot. Asserts it returns the full catalog with all bindings (projectId null) and filters
// bindings to one project when a projectId is given.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpProjectionQuery,
  McpProjectionQueryLive,
  McpServerId,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
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
import { mcpEngineLayer, mcpSecretStoreLayer } from "../../mcp/mcpPorts.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";

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
const unbind = (p: string, s: string, c: string): OrchestrationCommand => ({
  type: "mcp.binding-remove",
  commandId: CommandId.make(c),
  projectId: ProjectId.make(p),
  serverId: McpServerId.make(s),
});

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-pq-test-" });
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
  const base = mcpEngineLayer.pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(McpProjectionQueryLive.pipe(Layer.provideMerge(base)));
  return {
    dispatch: (cmd: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (e) => e.dispatch(cmd)),
      ),
    snapshot: (projectId: string | null) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpProjectionQuery), (q) =>
          q.getSnapshot(projectId === null ? null : ProjectId.make(projectId)),
        ),
      ),
    // Subscribe to subscriptionStream, take `count` emissions, dispatch `cmd` once the subscription is
    // live, and return the collected snapshot events. Exercises the live `changeSnapshots` stream.
    collectAfterDispatch: (count: number, cmd: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const query = yield* Effect.service(McpProjectionQuery);
          const engine = yield* Effect.service(OrchestrationEngineService);
          const collecting = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(query.subscriptionStream, count)),
          );
          yield* Effect.sleep("100 millis"); // let the subscription attach before the event fires
          yield* engine.dispatch(cmd);
          return yield* Fiber.join(collecting); // Stream.runCollect already yields an Array
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("McpProjectionQuery.getSnapshot", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("null projectId returns the full catalog and ALL bindings", async () => {
    await system.dispatch(projectCreate("pa", "pca"));
    await system.dispatch(projectCreate("pb", "pcb"));
    await system.dispatch(add("s1", "add:1"));
    await system.dispatch(add("s2", "add:2"));
    await system.dispatch(bind("pa", "s1", "bind:a1"));
    await system.dispatch(bind("pb", "s2", "bind:b2"));

    const snap = await system.snapshot(null);
    expect(snap.catalog.map((s) => s.id).toSorted()).toEqual(["s1", "s2"]);
    expect(snap.bindings).toHaveLength(2);
  });

  it("a projectId filters bindings to that project (catalog stays full)", async () => {
    await system.dispatch(projectCreate("pa", "pca"));
    await system.dispatch(projectCreate("pb", "pcb"));
    await system.dispatch(add("s1", "add:1"));
    await system.dispatch(add("s2", "add:2"));
    await system.dispatch(bind("pa", "s1", "bind:a1"));
    await system.dispatch(bind("pb", "s2", "bind:b2"));

    const snap = await system.snapshot("pa");
    expect(snap.catalog).toHaveLength(2); // catalog is global
    expect(snap.bindings.map((b) => b.projectId)).toEqual(["pa"]); // only pa's binding
    expect(snap.bindings[0]?.serverId).toBe("s1");
  });

  it("subscriptionStream emits a fresh snapshot when a relevant event lands", async () => {
    // Element 1 is the initial snapshot (empty); element 2 is re-read by `changeSnapshots` after the add.
    const events = await system.collectAfterDispatch(2, add("s-stream", "add:stream"));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("snapshot");
    expect(events[0]?.snapshot.catalog.map((s) => s.id)).toEqual([]); // before the add
    expect(events[1]?.snapshot.catalog.map((s) => s.id)).toEqual(["s-stream"]); // after the add
  }, 15_000);

  it("mcp.binding-remove cascades: the binding disappears from the snapshot", async () => {
    await system.dispatch(projectCreate("pr", "pcr"));
    await system.dispatch(add("sr", "add:r"));
    await system.dispatch(bind("pr", "sr", "bind:r"));
    expect((await system.snapshot("pr")).bindings).toHaveLength(1);

    await system.dispatch(unbind("pr", "sr", "unbind:r"));
    expect((await system.snapshot("pr")).bindings).toEqual([]);
  });
});
