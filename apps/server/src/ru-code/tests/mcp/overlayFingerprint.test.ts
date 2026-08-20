// ru-code: the RESTART-DECISION half of the qwen integration. ProviderCommandReactor re-spawns a live
// session when, at turn-start, the project's overlay FINGERPRINT differs from what the session spawned
// with (qwen only reads the overlay at spawn). So "does editing X restart the CLI?" reduces to "does
// editing X change resolveOverlay's fingerprint?". This file pins that down on the REAL McpOverlay:
//   - changing a required var's VALUE (referenced in the config) → fingerprint CHANGES → restart;
//   - changing ONLY the catalog description → fingerprint UNCHANGED → no restart;
//   - changing the tool policy → fingerprint CHANGES → restart;
//   - per-project ISOLATION: a per-project var change in project A moves A's fingerprint but NOT B's,
//     so a settings change in one project never restarts another project's thread.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpOverlay,
  McpOverlayLive,
  McpServerId,
  type McpToolPolicy,
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

const ISO = "2026-01-01T00:00:00.000Z";

// A server whose required, per-project var is referenced in the spawned config (so its value is part
// of the resolved config that feeds the fingerprint).
const addServerWithVar = (serverId: string): OrchestrationCommand => ({
  type: "mcp.server-add",
  commandId: CommandId.make(`add-${serverId}`),
  serverId: McpServerId.make(serverId),
  draft: {
    name: serverId,
    config: { transport: "stdio", command: "uvx", args: [serverId, "--token", "${TOKEN}"] },
    vars: [{ name: "TOKEN", secret: false, perProject: true, required: true, value: null }],
    timeoutMs: null,
  },
  createdAt: ISO,
});

const createProject = (projectId: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make(`proj-${projectId}`),
  projectId: ProjectId.make(projectId),
  title: "P",
  workspaceRoot: `/tmp/${projectId}`,
  createdAt: ISO,
});

const bindWithToken = (
  projectId: string,
  serverId: string,
  token: string,
  commandId: string,
): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(commandId),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true, varValues: { TOKEN: token } },
});

const setToolPolicy = (
  projectId: string,
  serverId: string,
  toolPolicy: McpToolPolicy,
  commandId: string,
): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(commandId),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true, varValues: { TOKEN: "alpha" }, toolPolicy },
});

const setDescription = (
  serverId: string,
  description: string,
  commandId: string,
): OrchestrationCommand => ({
  type: "mcp.server-update",
  commandId: CommandId.make(commandId),
  serverId: McpServerId.make(serverId),
  patch: { description },
});

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-fp-test-" });
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
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(McpOverlayLive.pipe(Layer.provideMerge(base)));
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (e) => e.dispatch(command)),
      ),
    // The restart diff runs on the IN-MEMORY resolution — no file write involved.
    fingerprint: (projectId: string): Promise<string> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay
            .resolveOverlay(ProjectId.make(projectId))
            .pipe(Effect.map((result) => result.fingerprint)),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("overlay fingerprint = the restart trigger (what change forces a respawn)", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("changing a required var's VALUE changes the fingerprint (→ CLI restarts next turn)", async () => {
    await system.dispatch(createProject("p1"));
    await system.dispatch(addServerWithVar("srv"));
    await system.dispatch(bindWithToken("p1", "srv", "alpha", "bind-1"));
    const before = await system.fingerprint("p1");

    await system.dispatch(bindWithToken("p1", "srv", "beta", "bind-2")); // same var, new value
    const after = await system.fingerprint("p1");

    expect(after).not.toBe(before);
  });

  it("changing ONLY the catalog description does NOT change the fingerprint (→ no restart)", async () => {
    await system.dispatch(createProject("p1"));
    await system.dispatch(addServerWithVar("srv"));
    await system.dispatch(bindWithToken("p1", "srv", "alpha", "bind-1"));
    const before = await system.fingerprint("p1");

    await system.dispatch(
      setDescription("srv", "A brand new description that qwen never sees", "desc-1"),
    );
    const after = await system.fingerprint("p1");

    expect(after).toBe(before); // description is catalog metadata, not part of the spawned overlay
  });

  it("changing the tool policy changes the fingerprint (→ restart; allow-list is subsumed)", async () => {
    await system.dispatch(createProject("p1"));
    await system.dispatch(addServerWithVar("srv"));
    await system.dispatch(bindWithToken("p1", "srv", "alpha", "bind-1"));
    const before = await system.fingerprint("p1");

    await system.dispatch(
      setToolPolicy("p1", "srv", { defaultDecision: "deny", exceptions: ["only_this"] }, "pol-1"),
    );
    const after = await system.fingerprint("p1");

    expect(after).not.toBe(before);
  });

  it("per-project isolation: a var change in project A leaves project B's fingerprint untouched", async () => {
    await system.dispatch(createProject("pa"));
    await system.dispatch(createProject("pb"));
    await system.dispatch(addServerWithVar("srv")); // ONE catalog server, bound per project
    await system.dispatch(bindWithToken("pa", "srv", "a-value", "bind-a"));
    await system.dispatch(bindWithToken("pb", "srv", "b-value", "bind-b"));

    const aBefore = await system.fingerprint("pa");
    const bBefore = await system.fingerprint("pb");

    // Change ONLY project A's per-project var value.
    await system.dispatch(bindWithToken("pa", "srv", "a-value-2", "bind-a2"));

    const aAfter = await system.fingerprint("pa");
    const bAfter = await system.fingerprint("pb");

    expect(aAfter).not.toBe(aBefore); // A's thread will restart
    expect(bAfter).toBe(bBefore); // B's thread will NOT — its overlay is unchanged
  });
});
