// ru-fork: behavior tests for the McpSupervisor PROBE EXECUTION loop — the live machinery that
// supervisorReconcile/supervisorDecisions don't touch. We drive REAL child-process probes:
//   - the fake stdio MCP server (online: connect → listTools → close, write-through to the cache),
//   - a missing binary (hard offline),
//   - `sleep` (a slow probe held in-flight, to exercise coalescing + the reconciled-away race).
// Covers runProbe / applyProbeResult / probeInstance (claim/release bracket) / probeHashes / recheck.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { IsoDateTime, type McpProbeRecord } from "@t3tools/contracts";
import type { ResolvedServerConfig } from "@ru-fork/mcp-core";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpProbeCacheRepositoryLive } from "../../../src/persistence/Layers/ProjectionMcpProbeCache.ts";
import { McpProbeCacheRepository } from "../../../src/persistence/Services/McpProbeCache.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../src/serverSettings.ts";
import {
  McpSupervisor,
  McpSupervisorLive,
  type DesiredInstance,
  type McpSupervisorShape,
} from "../../../src/ru-fork/mcp/McpSupervisor.ts";

// packages/mcp-core/test-fixtures/fakeMcpStdioServer.mjs (real stdio MCP server, advertises echo+ping).
const FAKE_SERVER = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../../packages/mcp-core/test-fixtures/fakeMcpStdioServer.mjs",
);

const onlineConfig: ResolvedServerConfig = {
  transport: "stdio",
  command: "node",
  args: [FAKE_SERVER],
  env: {},
  cwd: process.cwd(),
  timeoutMs: 10_000,
};

const offlineConfig: ResolvedServerConfig = {
  transport: "stdio",
  command: "this-binary-does-not-exist-9z3a",
  args: [],
  env: {},
  cwd: process.cwd(),
  timeoutMs: 3_000,
};

// `sleep` never answers the MCP handshake — the probe stays in flight until its (short) timeout.
const slowConfig: ResolvedServerConfig = {
  transport: "stdio",
  command: "sleep",
  args: ["30"],
  env: {},
  cwd: process.cwd(),
  timeoutMs: 1_500,
};

const desired = (
  hash: string,
  configKey: string,
  resolved: ResolvedServerConfig,
  refs: ReadonlyArray<string>,
): Map<string, DesiredInstance> =>
  new Map([[hash, { hash, configKey, resolved, refs: new Set(refs) }]]);

function makeSystem() {
  const probeCacheLayer = McpProbeCacheRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));
  const supervisorLayer = McpSupervisorLive.pipe(
    Layer.provide(probeCacheLayer),
    Layer.provide(ServerSettingsService.layerTest()),
  );
  const runtime = ManagedRuntime.make(Layer.mergeAll(supervisorLayer, probeCacheLayer));
  return {
    // Run an arbitrary effect with the supervisor in scope (for multi-step concurrency tests).
    withSupervisor: <A>(body: (supervisor: McpSupervisorShape) => Effect.Effect<A>): Promise<A> =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), body)),
    instances: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), (s) => s.currentInstances)),
    cacheRow: (configKey: string) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpProbeCacheRepository), (r) => r.getByKey({ configKey })),
      ),
    seed: (record: McpProbeRecord) =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpProbeCacheRepository), (r) => r.upsert(record))),
    dispose: () => runtime.dispose(),
  };
}

describe("McpSupervisor probe execution loop", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("probeHashes runs a REAL online probe: registry → online with tools, latency, checkedAt", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-on", "ck-on", onlineConfig, ["catalog:s"]));
        yield* s.probeHashes(["h-on"]);
      }),
    );
    const inst = (await system.instances()).find((i) => i.hash === "h-on");
    expect(inst?.status).toBe("online");
    expect(inst?.discoveredTools.map((t) => t.name).toSorted()).toEqual(["echo", "ping"]);
    expect(typeof inst?.latencyMs).toBe("number");
    expect(inst?.checkedAt).not.toBeNull();
    expect(inst?.checkedAtMs).not.toBeNull();
    expect(inst?.consecutiveFailures).toBe(0);
  }, 20_000);

  it("write-through: a successful probe upserts the config-keyed cache row", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-wt", "ck-wt", onlineConfig, ["catalog:s"]));
        yield* s.probeHashes(["h-wt"]);
      }),
    );
    const row = await system.cacheRow("ck-wt");
    expect(row._tag).toBe("Some");
    if (row._tag === "Some") {
      expect(row.value.status).toBe("online");
      expect(row.value.tools.map((t) => t.name).toSorted()).toEqual(["echo", "ping"]);
      expect(row.value.transport).toBe("stdio");
    }
  }, 20_000);

  it("a hard failure (missing binary) → offline, consecutiveFailures = 1, no tools", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-off", "ck-off", offlineConfig, ["catalog:s"]));
        yield* s.probeHashes(["h-off"]);
      }),
    );
    const inst = (await system.instances()).find((i) => i.hash === "h-off");
    expect(inst?.status).toBe("offline");
    expect(inst?.consecutiveFailures).toBe(1);
    expect(inst?.discoveredTools).toEqual([]);
    expect(inst?.message).not.toBeNull();
  }, 20_000);

  it("consecutiveFailures accumulates across repeated hard-offline probes (1 → 2 → 3)", async () => {
    const failuresAfterEachProbe: Array<number> = [];
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-acc", "ck-acc", offlineConfig, ["catalog:s"]));
        for (let probe = 0; probe < 3; probe++) {
          yield* s.probeHashes(["h-acc"]);
          const inst = (yield* s.currentInstances).find((i) => i.hash === "h-acc");
          failuresAfterEachProbe.push(inst?.consecutiveFailures ?? -1);
        }
      }),
    );
    expect(failuresAfterEachProbe).toEqual([1, 2, 3]);
    const inst = (await system.instances()).find((i) => i.hash === "h-acc");
    expect(inst?.status).toBe("offline"); // a hard (non-timeout) failure is offline at every step
  }, 30_000);

  it("coalesces concurrent probes of the SAME config — one in-flight slot, the 2nd is a no-op", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-co", "ck-co", slowConfig, ["catalog:s"]));
        // Start a slow probe and let it claim the in-flight slot.
        const probing = yield* Effect.forkChild(s.probeHashes(["h-co"]));
        yield* Effect.sleep("200 millis");
        expect([...(yield* s.currentInFlight)]).toEqual(["h-co"]);
        // A second probe of the same hash must coalesce: it returns ~immediately and adds no slot.
        yield* s.probeHashes(["h-co"]);
        expect((yield* s.currentInFlight).size).toBe(1);
        yield* Fiber.await(probing); // let the slow probe settle (timeout) before teardown
        expect((yield* s.currentInFlight).size).toBe(0);
      }),
    );
  }, 20_000);

  it("an instance reconciled away mid-probe is NOT resurrected by the late probe result", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-race", "ck-race", slowConfig, ["catalog:s"]));
        const probing = yield* Effect.forkChild(s.probeHashes(["h-race"]));
        yield* Effect.sleep("200 millis");
        // Drop the instance while its probe is still running.
        yield* s.reconcile(new Map());
        yield* Fiber.await(probing); // applyProbeResult sees no `latest` → returns registry unchanged
        expect(yield* s.currentInstances).toEqual([]);
      }),
    );
  }, 20_000);

  it("recheck bypasses the due-gate: it probes a NEVER-probed instance", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-rc", "ck-rc", onlineConfig, ["p1:s"]));
        // Never probed ⇒ the sweep would skip it; recheck forces it anyway.
        yield* s.recheck({ projectId: "p1" });
      }),
    );
    const inst = (await system.instances()).find((i) => i.hash === "h-rc");
    expect(inst?.status).toBe("online");
  }, 20_000);

  it("probeHashes is a no-op for an empty list and for unknown hashes", async () => {
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-known", "ck-known", onlineConfig, ["catalog:s"]));
        yield* s.probeHashes([]); // empty
        yield* s.probeHashes(["does-not-exist"]); // unmatched
      }),
    );
    const inst = (await system.instances()).find((i) => i.hash === "h-known");
    expect(inst?.status).toBe("unchecked"); // never actually probed
  });

  it("seeds status from the cache on reconcile, then a probe overwrites it with the live result", async () => {
    await system.seed({
      configKey: "ck-seed",
      transport: "stdio",
      status: "offline",
      tools: [],
      lastError: "stale",
      serverDescription: null,
      serverWebsiteUrl: null,
      checkedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      checkedAtMs: 1_000_000,
    });
    await system.withSupervisor((s) => s.reconcile(desired("h-seed", "ck-seed", onlineConfig, ["catalog:s"])));
    const seeded = (await system.instances()).find((i) => i.hash === "h-seed");
    expect(seeded?.status).toBe("offline"); // hydrated from the stale cache row
    expect(seeded?.checkedAtMs).toBe(1_000_000);

    await system.withSupervisor((s) => s.probeHashes(["h-seed"]));
    const probed = (await system.instances()).find((i) => i.hash === "h-seed");
    expect(probed?.status).toBe("online"); // live probe replaced the stale status
    expect(probed?.checkedAtMs).toBeGreaterThan(1_000_000);
  }, 20_000);
});
