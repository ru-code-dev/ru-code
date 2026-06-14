// ru-fork: McpRuntime.currentSnapshot swallows a read failure into an EMPTY snapshot
// (`McpRuntime.ts:104` — `Effect.catch(() => Effect.succeed({ runtimes: [], catalogRuntimes: [] }))`).
// Test A pins the intended resilience (a transient repo failure must not crash the UI stream → GREEN).
// Test B pins that the swallow must be OBSERVABLE: right now it is silent, so a debug log of the failure
// is absent ⇒ RED until a `logDebug` is added in that catch.

import { PersistenceSqlError } from "../../../src/persistence/Errors.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpProbeCacheRepositoryLive } from "../../../src/persistence/Layers/ProjectionMcpProbeCache.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
import {
  McpCatalogRepository,
  type McpCatalogRepositoryShape,
} from "../../../src/persistence/Services/McpCatalog.ts";
import {
  McpBindingRepository,
  type McpBindingRepositoryShape,
} from "../../../src/persistence/Services/McpBinding.ts";
import { ServerSettingsService } from "../../../src/serverSettings.ts";
import { McpRuntime, McpRuntimeLive } from "../../../src/ru-fork/mcp/McpRuntime.ts";
import { McpSupervisorLive } from "../../../src/ru-fork/mcp/McpSupervisor.ts";

// catalogRepository.listAll fails with a real ProjectionRepositoryError ⇒ the snapshot build fails and
// hits the `Effect.catch` at McpRuntime.ts:104.
const failingCatalog = {
  listAll: () => Effect.fail(new PersistenceSqlError({ operation: "listAll", detail: "injected failure" })),
  upsert: () => Effect.die("upsert is unused in this test"),
  remove: () => Effect.die("remove is unused in this test"),
} satisfies McpCatalogRepositoryShape;

const emptyBinding = {
  listAll: () => Effect.succeed([]),
  upsert: () => Effect.die("upsert is unused in this test"),
  remove: () => Effect.die("remove is unused in this test"),
  listByProject: () => Effect.die("listByProject is unused in this test"),
  removeByProject: () => Effect.die("removeByProject is unused in this test"),
  removeByServer: () => Effect.die("removeByServer is unused in this test"),
} satisfies McpBindingRepositoryShape;

function makeSystem() {
  const captured: Array<{ readonly level: string; readonly message: string }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    captured.push({ level: String(logLevel), message: String(message) });
  });
  const probeCacheLayer = McpProbeCacheRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));
  const supervisorLayer = McpSupervisorLive.pipe(
    Layer.provide(probeCacheLayer),
    Layer.provide(ServerSettingsService.layerTest()),
  );
  const runtime = ManagedRuntime.make(
    McpRuntimeLive.pipe(
      Layer.provideMerge(supervisorLayer),
      Layer.provideMerge(Layer.succeed(McpCatalogRepository, failingCatalog)),
      Layer.provideMerge(Layer.succeed(McpBindingRepository, emptyBinding)),
      Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
      Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")), // so logDebug is captured
    ),
  );
  return {
    snapshotHead: () =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpRuntime), (rt) =>
          Stream.runHead(rt.subscriptionStream).pipe(Effect.map(Option.getOrThrow)),
        ),
      ),
    captured,
    dispose: () => runtime.dispose(),
  };
}

describe("McpRuntime.currentSnapshot resilience (read failure → empty snapshot)", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("returns an empty snapshot (does not crash the UI stream) when a repo read fails", async () => {
    const event = await system.snapshotHead();
    expect(event.type).toBe("snapshot");
    expect(event.runtimes).toEqual([]);
    expect(event.catalogRuntimes).toEqual([]);
  });

  it("logs the swallowed snapshot failure at debug level", async () => {
    await system.snapshotHead();
    // EXPECTED: the swallow is observable. Current code catches silently ⇒ RED until a logDebug is added.
    const debugLog = system.captured.find(
      (entry) =>
        entry.level.toUpperCase().includes("DEBUG") && entry.message.toLowerCase().includes("snapshot"),
    );
    expect(debugLog).toBeDefined();
  });
});
