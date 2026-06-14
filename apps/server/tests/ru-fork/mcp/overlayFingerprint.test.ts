// ru-fork: the RESTART-DECISION half of the qwen integration. ProviderCommandReactor re-spawns a live
// session when, at turn-start, the project's overlay FINGERPRINT differs from what the session spawned
// with (qwen only reads the overlay at spawn). So "does editing X restart the CLI?" reduces to "does
// editing X change writeOverlay's fingerprint?". This file pins that down on the REAL McpOverlay:
//   - changing a required var's VALUE (referenced in the config) → fingerprint CHANGES → restart;
//   - changing ONLY the catalog description → fingerprint UNCHANGED → no restart;
//   - changing the tool policy → fingerprint CHANGES → restart;
//   - per-project ISOLATION: a per-project var change in project A moves A's fingerprint but NOT B's,
//     so a settings change in one project never restarts another project's thread.

import {
  CommandId,
  McpServerId,
  ProjectId,
  type McpToolPolicy,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../../src/config.ts";
import { McpOverlay, McpOverlayLive } from "../../../src/ru-fork/mcp/McpOverlay.ts";

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

const bindWithToken = (projectId: string, serverId: string, token: string, commandId: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(commandId),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true, varValues: { TOKEN: token } },
});

const setToolPolicy = (projectId: string, serverId: string, toolPolicy: McpToolPolicy, commandId: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(commandId),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true, varValues: { TOKEN: "alpha" }, toolPolicy },
});

const setDescription = (serverId: string, description: string, commandId: string): OrchestrationCommand => ({
  type: "mcp.server-update",
  commandId: CommandId.make(commandId),
  serverId: McpServerId.make(serverId),
  patch: { description },
});

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-fp-test-" });
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
  );
  const runtime = ManagedRuntime.make(McpOverlayLive.pipe(Layer.provideMerge(base)));
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(Effect.flatMap(Effect.service(OrchestrationEngineService), (e) => e.dispatch(command))),
    fingerprint: (projectId: string): Promise<string> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay.writeOverlay(ProjectId.make(projectId)).pipe(Effect.map((result) => result.fingerprint)),
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

    await system.dispatch(setDescription("srv", "A brand new description that qwen never sees", "desc-1"));
    const after = await system.fingerprint("p1");

    expect(after).toBe(before); // description is catalog metadata, not part of the spawned overlay
  });

  it("changing the tool policy changes the fingerprint (→ restart; allow-list is subsumed)", async () => {
    await system.dispatch(createProject("p1"));
    await system.dispatch(addServerWithVar("srv"));
    await system.dispatch(bindWithToken("p1", "srv", "alpha", "bind-1"));
    const before = await system.fingerprint("p1");

    await system.dispatch(setToolPolicy("p1", "srv", { defaultDecision: "deny", exceptions: ["only_this"] }, "pol-1"));
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
