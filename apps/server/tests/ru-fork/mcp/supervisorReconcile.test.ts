// ru-fork: behavior tests for McpSupervisor.reconcile — the in-memory instance registry sync. A
// brand-new desired instance registers as `unchecked`; one whose configKey has a cached probe seeds
// its status from the cache; a re-reconcile preserves an existing instance's status while updating its
// ref set; and reconcile reports which hashes are newly registered.

import { IsoDateTime, type McpProbeRecord } from "@t3tools/contracts";
import type { ResolvedServerConfig } from "@ru-fork/mcp-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpProbeCacheRepositoryLive } from "../../../src/persistence/Layers/ProjectionMcpProbeCache.ts";
import { McpProbeCacheRepository } from "../../../src/persistence/Services/McpProbeCache.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../src/serverSettings.ts";
import { McpSupervisor, McpSupervisorLive, type DesiredInstance } from "../../../src/ru-fork/mcp/McpSupervisor.ts";

const resolved: ResolvedServerConfig = {
  transport: "stdio",
  command: "uvx",
  args: ["demo"],
  env: {},
  cwd: "/probe",
};

const desired = (refs: ReadonlyArray<string>): Map<string, DesiredInstance> =>
  new Map([["h1", { hash: "h1", configKey: "ck1", resolved, refs: new Set(refs) }]]);

function makeSystem() {
  const probeCacheLayer = McpProbeCacheRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));
  const supervisorLayer = McpSupervisorLive.pipe(
    Layer.provide(probeCacheLayer),
    Layer.provide(ServerSettingsService.layerTest()),
  );
  const runtime = ManagedRuntime.make(Layer.mergeAll(supervisorLayer, probeCacheLayer));
  return {
    reconcile: (d: Map<string, DesiredInstance>) =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), (s) => s.reconcile(d))),
    instances: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), (s) => s.currentInstances)),
    seed: (record: McpProbeRecord) =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpProbeCacheRepository), (r) => r.upsert(record))),
    dispose: () => runtime.dispose(),
  };
}

describe("McpSupervisor.reconcile — registry sync", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("registers a brand-new desired instance as unchecked + reports it as newly added", async () => {
    const added = await system.reconcile(desired(["catalog:s"]));
    expect([...added]).toContain("h1");
    const inst = (await system.instances()).find((i) => i.hash === "h1");
    expect(inst?.status).toBe("unchecked");
    expect(inst?.latencyMs).toBeNull();
    expect([...(inst?.refs ?? [])]).toEqual(["catalog:s"]);
  });

  it("seeds status from a cached probe row matching the configKey", async () => {
    await system.seed({
      configKey: "ck1",
      transport: "stdio",
      status: "online",
      tools: [{ name: "echo", description: "Echo" }],
      lastError: null,
      serverDescription: null,
      serverWebsiteUrl: null,
      checkedAt: IsoDateTime.make("2026-06-07T10:00:00.000Z"),
      checkedAtMs: 1_780_000_000_000,
    });
    await system.reconcile(desired(["catalog:s"]));
    const inst = (await system.instances()).find((i) => i.hash === "h1");
    expect(inst?.status).toBe("online");
    expect(inst?.discoveredTools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("a re-reconcile updates the ref set and reports the instance as newly-REFERENCED (F1)", async () => {
    await system.reconcile(desired(["catalog:s"]));
    const added2 = await system.reconcile(desired(["catalog:s", "p1:s"]));
    // F1: reconcile returns brand-new OR newly-referenced hashes, so a freshly-bound server is probed.
    expect([...added2]).toContain("h1");
    const inst = (await system.instances()).find((i) => i.hash === "h1");
    expect([...(inst?.refs ?? [])].toSorted()).toEqual(["catalog:s", "p1:s"]);

    // A reconcile with NO new ref does not re-report it.
    const added3 = await system.reconcile(desired(["catalog:s", "p1:s"]));
    expect([...added3]).not.toContain("h1");
  });
});
