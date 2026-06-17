// ru-fork: REPRO for the built-in seeding bug — "add a built-in, restart → it appears; add a SECOND
// built-in, restart → the FIRST disappears; you must restart twice to see both."
//
// These drive the REAL reactor reconcile loop (`reconcileBuiltinsWith`) through the REAL engine
// (decider → event → SQL projection), varying the shipped-definition list the way editing
// `mcpBuiltinDefinitions.ts` + restarting does. Each `reconcile([...])` call IS one app restart.
//
// The assertions encode the CORRECT behaviour: the shipped set is the source of truth, so after a
// reconcile the catalog must contain EXACTLY the shipped built-ins — every one of them, in a SINGLE
// pass. On the buggy build these go RED (the first built-in is dropped / a second restart is needed);
// on a correct build they are green. Pure seeding-side: if these PASS but the UI still shows one
// server, the fault is the client projection push, not seeding (see the SQL diagnostic in the report).

import type { McpCatalogServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { McpCatalogRepository } from "../../../src/persistence/Services/McpCatalog.ts";
import { RepositoryIdentityResolverLive } from "../../../src/project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../../src/config.ts";
import type { McpBuiltinDefinition } from "../../../src/ru-fork/mcp/McpBuiltins.ts";
import { reconcileBuiltinsWith } from "../../../src/ru-fork/mcp/McpReactor.ts";

// Two CLEARLY distinct built-ins: different builtinId, different config (different args ⇒ different
// configIdentity ⇒ different serverId). No platform skip (`default` variant), no identity collision.
// On a correct build, shipping both MUST yield both — nothing here justifies dropping either.
const ALPHA: McpBuiltinDefinition = {
  builtinId: "alpha",
  name: "alpha",
  description: "Alpha built-in",
  config: { default: { transport: "stdio", command: "uvx", args: ["alpha"] } },
  vars: [],
};
const BETA: McpBuiltinDefinition = {
  builtinId: "beta",
  name: "beta",
  description: "Beta built-in",
  config: { default: { transport: "stdio", command: "uvx", args: ["beta"] } },
  vars: [],
};
const GAMMA: McpBuiltinDefinition = {
  builtinId: "gamma",
  name: "gamma",
  description: "Gamma built-in",
  config: { default: { transport: "stdio", command: "uvx", args: ["gamma"] } },
  vars: [],
};

const builtinIds = (catalog: ReadonlyArray<McpCatalogServer>): ReadonlyArray<string> =>
  catalog
    .map((server) => server.builtinId)
    .filter((id): id is string => id !== null)
    .toSorted();

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-seed-test-" });
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    // Merge the pipeline too so its McpCatalogRepository output is queryable from the runtime.
    OrchestrationProjectionPipelineLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    // One restart with a given shipped-definition list (the real reconcile loop = the testability seam).
    reconcile: (definitions: ReadonlyArray<McpBuiltinDefinition>) =>
      runtime.runPromise(reconcileBuiltinsWith(definitions, process.platform)),
    catalog: (): Promise<ReadonlyArray<McpCatalogServer>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpCatalogRepository), (repo) => repo.listAll()),
      ),
    // The engine must be live (its command worker processes the reconcile's dispatches).
    warmEngine: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(OrchestrationEngineService), () => Effect.void)),
    dispose: () => runtime.dispose(),
  };
}

describe("built-in seeding accumulates across restarts (Problem 1 repro)", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(async () => {
    system = makeSystem();
    await system.warmEngine();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("adding a SECOND built-in across restarts keeps the FIRST (the exact symptom)", async () => {
    // Restart 1: ship only ALPHA → it appears.
    await system.reconcile([ALPHA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha"]);

    // Restart 2: edit mcpBuiltinDefinitions.ts to add BETA, restart. ALPHA must NOT vanish.
    await system.reconcile([ALPHA, BETA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "beta"]);
  });

  it("shipping two built-ins appears in ONE reconcile, not two (no second-restart needed)", async () => {
    // Single restart from an empty catalog with both shipped → both present immediately.
    await system.reconcile([ALPHA, BETA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "beta"]);
  });

  it("a redundant restart with the SAME shipped list is stable (no churn, no loss)", async () => {
    await system.reconcile([ALPHA, BETA]);
    // "Restart twice": an identical reconcile must neither drop nor duplicate anything.
    await system.reconcile([ALPHA, BETA]);
    const catalog = await system.catalog();
    expect(builtinIds(catalog)).toEqual(["alpha", "beta"]);
    // No duplicate rows for the same built-in.
    expect(catalog.filter((s) => s.builtinId === "alpha")).toHaveLength(1);
    expect(catalog.filter((s) => s.builtinId === "beta")).toHaveLength(1);
  });

  it("growing the shipped list one at a time accumulates EVERY built-in", async () => {
    await system.reconcile([ALPHA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha"]);

    await system.reconcile([ALPHA, BETA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "beta"]);

    await system.reconcile([ALPHA, BETA, GAMMA]);
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "beta", "gamma"]);
  });

  it("adding a NEW built-in never collaterally removes an already-installed sibling", async () => {
    await system.reconcile([ALPHA]);
    const before = await system.catalog();
    const alphaBefore = before.find((s) => s.builtinId === "alpha");
    expect(alphaBefore).toBeDefined();

    // Ship BETA alongside ALPHA; ALPHA's row must survive untouched (same id, same config).
    await system.reconcile([ALPHA, BETA]);
    const after = await system.catalog();
    const alphaAfter = after.find((s) => s.builtinId === "alpha");
    expect(alphaAfter).toBeDefined();
    expect(alphaAfter?.id).toBe(alphaBefore?.id);
    expect(alphaAfter?.config).toEqual(alphaBefore?.config);
  });
});
