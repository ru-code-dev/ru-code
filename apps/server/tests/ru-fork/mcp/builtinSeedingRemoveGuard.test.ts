// ru-fork: PINPOINT tests for the remove loop (McpReactor.ts:168) — the only path that makes a
// built-in "disappear." The other two files assert the catalog END STATE (a vanished built-in fails
// them); this file additionally OBSERVES THE EVENT LOG, so it proves WHICH loop fired. It directly
// asserts the invariant Loop 2 must uphold: **a still-shipped built-in is never `mcp.server-remove`d.**
//
// Covers the three ways the first built-in can be wrongly deleted (see the loop analysis):
//   1. `shippedBuiltinIds` built wrong (e.g. scoped inside the loop ⇒ only the last def is "shipped").
//   2. platform-skip: a def with no variant for the current OS skips `.add()` ⇒ a collateral remove.
//   3. builtinId mismatch: the projected `builtin_id` must round-trip the shipped id, or membership fails.

import type { McpCatalogServer, OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
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

const ALPHA: McpBuiltinDefinition = {
  builtinId: "alpha",
  name: "alpha",
  config: { default: { transport: "stdio", command: "uvx", args: ["alpha"] } },
  vars: [],
};
const BETA: McpBuiltinDefinition = {
  builtinId: "beta",
  name: "beta",
  config: { default: { transport: "stdio", command: "uvx", args: ["beta"] } },
  vars: [],
};
// A built-in with a variant ONLY for win32 — null under darwin/linux (exercises the platform-skip path).
const WIN_ONLY: McpBuiltinDefinition = {
  builtinId: "winonly",
  name: "winonly",
  config: { win32: { transport: "stdio", command: "uvx", args: ["winonly"] } },
  vars: [],
};

const builtinIds = (catalog: ReadonlyArray<McpCatalogServer>): ReadonlyArray<string> =>
  catalog
    .map((server) => server.builtinId)
    .filter((id): id is string => id !== null)
    .toSorted();

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-rmguard-test-" });
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
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    // `platform` is overridable so the platform-skip path can be driven deterministically.
    reconcile: (definitions: ReadonlyArray<McpBuiltinDefinition>, platform: NodeJS.Platform = process.platform) =>
      runtime.runPromise(reconcileBuiltinsWith(definitions, platform)),
    catalog: (): Promise<ReadonlyArray<McpCatalogServer>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpCatalogRepository), (repo) => repo.listAll()),
      ),
    // The full event log — lets us see exactly which mcp.* events the reconcile produced.
    events: (): Promise<ReadonlyArray<OrchestrationEvent>> =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (engine) =>
          Stream.runCollect(engine.readEvents(0)).pipe(
            Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
          ),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}

const removedServerIds = (events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> =>
  events.filter((e) => e.type === "mcp.server-removed").map((e) => (e as { payload: { serverId: string } }).payload.serverId);

describe("the remove loop never deletes a still-shipped built-in", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("failure mode #1: adding a second built-in emits NO server-remove (shippedBuiltinIds holds BOTH)", async () => {
    await system.reconcile([ALPHA]);
    await system.reconcile([ALPHA, BETA]); // the moment the first is reported to disappear
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "beta"]);
    // The smoking gun: a removal here means Loop 2 saw alpha as "not shipped".
    expect(removedServerIds(await system.events())).toEqual([]);
  });

  it("failure mode #2: a NEW built-in never collaterally removes a sibling supported on this OS", async () => {
    await system.reconcile([ALPHA]);
    const beforeEvents = (await system.events()).length;
    await system.reconcile([ALPHA, BETA]);
    // No server-removed event at all, and certainly not for alpha.
    expect(removedServerIds(await system.events())).not.toContain("srv-builtin-alpha");
    // (sanity) the second reconcile only ADDED — it did not churn the first.
    expect((await system.events()).length).toBeGreaterThan(beforeEvents);
  });

  it("platform-skip removes ONLY the unsupported built-in, not the supported sibling", async () => {
    // Install winonly as if on Windows, alongside alpha.
    await system.reconcile([ALPHA, WIN_ONLY], "win32");
    expect(builtinIds(await system.catalog())).toEqual(["alpha", "winonly"]);

    // Now reconcile on darwin: winonly has no variant ⇒ correctly removed; alpha MUST stay.
    await system.reconcile([ALPHA, WIN_ONLY], "darwin");
    expect(builtinIds(await system.catalog())).toEqual(["alpha"]);
    expect(removedServerIds(await system.events())).toEqual(["srv-builtin-winonly"]); // exactly one, the right one
  });

  it("failure mode #3: the projected builtin_id round-trips the shipped id (membership can't miss)", async () => {
    await system.reconcile([ALPHA, BETA]);
    const catalog = await system.catalog();
    // If the projector dropped/altered builtin_id, Loop 2's `shippedBuiltinIds.has(installed.builtinId)`
    // would silently fail and delete on the next reconcile. Pin the contract.
    expect(catalog.find((s) => s.id === "srv-builtin-alpha")?.builtinId).toBe("alpha");
    expect(catalog.find((s) => s.id === "srv-builtin-beta")?.builtinId).toBe("beta");
  });
});
