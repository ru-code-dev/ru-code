// ru-fork: behavior tests for the McpSupervisor SWEEP loop orchestration (`runSweep`, exposed for tests
// as `sweepOnce`). The periodic 60s loop only ever runs this body; here we run one tick deterministically
// and assert WHICH instances it re-probes: already-probed + due + watched, and nobody else. This covers
// the live monitoring scheduler that supervisorDecisions (pure isSweepDue) and supervisorProbe don't.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { IsoDateTime, type McpProbeRecord, type ServerSettings } from "@t3tools/contracts";
import type { ResolvedServerConfig } from "@ru-fork/mcp-core";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { afterEach, describe, expect, it } from "vitest";

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

const PAST_MS = 1_000_000; // far enough in the past that any non-zero interval has elapsed

const desired = (
  hash: string,
  configKey: string,
  refs: ReadonlyArray<string>,
): Map<string, DesiredInstance> =>
  new Map([[hash, { hash, configKey, resolved: onlineConfig, refs: new Set(refs) }]]);

// A cache row that hydrates an instance as already-probed (online) at PAST_MS, so the sweep treats it
// as due once its transport interval has elapsed.
const probedLongAgo = (configKey: string): McpProbeRecord => ({
  configKey,
  transport: "stdio",
  status: "online",
  tools: [{ name: "echo", description: "Echo" }],
  lastError: null,
  serverDescription: null,
  serverWebsiteUrl: null,
  checkedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  checkedAtMs: PAST_MS,
});

function makeSystem(settings: DeepPartial<ServerSettings> = {}) {
  const probeCacheLayer = McpProbeCacheRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));
  const supervisorLayer = McpSupervisorLive.pipe(
    Layer.provide(probeCacheLayer),
    Layer.provide(ServerSettingsService.layerTest(settings)),
  );
  const runtime = ManagedRuntime.make(Layer.mergeAll(supervisorLayer, probeCacheLayer));
  return {
    withSupervisor: <A>(body: (supervisor: McpSupervisorShape) => Effect.Effect<A>): Promise<A> =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), body)),
    instances: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpSupervisor), (s) => s.currentInstances)),
    seed: (record: McpProbeRecord) =>
      runtime.runPromise(Effect.flatMap(Effect.service(McpProbeCacheRepository), (r) => r.upsert(record))),
    dispose: () => runtime.dispose(),
  };
}

describe("McpSupervisor sweep loop orchestration (sweepOnce)", () => {
  let system: ReturnType<typeof makeSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("re-probes a watched, already-probed instance whose interval has elapsed", async () => {
    system = makeSystem(); // default intervals = 30 min, watched = null (all)
    await system.seed(probedLongAgo("ck-due"));
    await system.withSupervisor((s) => s.reconcile(desired("h-due", "ck-due", ["catalog:s"])));
    const before = (await system.instances()).find((i) => i.hash === "h-due");
    expect(before?.checkedAtMs).toBe(PAST_MS); // hydrated as probed-long-ago

    await system.withSupervisor((s) => s.sweepOnce);
    const after = (await system.instances()).find((i) => i.hash === "h-due");
    expect(after?.status).toBe("online");
    expect(after?.checkedAtMs).toBeGreaterThan(PAST_MS); // the sweep re-probed it (clock advanced)
  }, 20_000);

  it("never re-probes a never-probed instance (no probing on load)", async () => {
    system = makeSystem();
    // No cache seed ⇒ checkedAtMs null ⇒ unchecked.
    await system.withSupervisor((s) => s.reconcile(desired("h-new", "ck-new", ["catalog:s"])));
    await system.withSupervisor((s) => s.sweepOnce);
    const inst = (await system.instances()).find((i) => i.hash === "h-new");
    expect(inst?.status).toBe("unchecked");
    expect(inst?.checkedAtMs).toBeNull();
  });

  it("does nothing when both recheck intervals are 0 (loop off)", async () => {
    system = makeSystem({ mcp: { recheckLocalMinutes: 0, recheckRemoteMinutes: 0 } });
    await system.seed(probedLongAgo("ck-off"));
    await system.withSupervisor((s) => s.reconcile(desired("h-off", "ck-off", ["catalog:s"])));
    await system.withSupervisor((s) => s.sweepOnce);
    const inst = (await system.instances()).find((i) => i.hash === "h-off");
    expect(inst?.checkedAtMs).toBe(PAST_MS); // untouched — the sweep short-circuited
  });

  it("is a no-op on an empty registry", async () => {
    system = makeSystem();
    await system.withSupervisor((s) => s.sweepOnce);
    expect(await system.instances()).toEqual([]);
  });

  it("skips an instance whose project is not in the watched set", async () => {
    system = makeSystem();
    await system.seed(probedLongAgo("ck-unwatched"));
    await system.withSupervisor((s) =>
      Effect.gen(function* () {
        yield* s.reconcile(desired("h-unwatched", "ck-unwatched", ["p1:s"]));
        yield* s.setWatchedProjects(["some-other-project"]); // p1 is NOT watched
        yield* s.sweepOnce;
      }),
    );
    const inst = (await system.instances()).find((i) => i.hash === "h-unwatched");
    expect(inst?.checkedAtMs).toBe(PAST_MS); // due, but out of the watched scope ⇒ not re-probed
  });
});
