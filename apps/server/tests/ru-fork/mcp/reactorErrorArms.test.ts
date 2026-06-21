// ru-fork: prove the reactor's `catchCause → logError` hygiene arms are LIVE — i.e. that a failed
// internal dispatch is logged and the loop CONTINUES, and (unlike pruneByPrefix's dead catch) the catch
// can actually fire. We drive the already-exported seams directly with a fake engine whose `dispatch`
// dies and fake repos that force each dispatch, then assert the seam completes AND the arm logged. No
// pipeline, no real engine — so this stays decoupled. These are characterization tests (GREEN): a dead
// or mis-wired arm would make them fail.

import {
  IsoDateTime,
  McpServerId,
  ProjectId,
  type McpCatalogServer,
  type McpProbeRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  McpCatalogRepository,
  type McpCatalogRepositoryShape,
} from "../../../src/persistence/Services/McpCatalog.ts";
import {
  McpBindingRepository,
  type McpBindingRepositoryShape,
} from "../../../src/persistence/Services/McpBinding.ts";
import {
  McpProbeCacheRepository,
  type McpProbeCacheRepositoryShape,
} from "../../../src/persistence/Services/McpProbeCache.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../src/orchestration/Services/OrchestrationEngine.ts";
import { buildAddedServer, buildBinding, buildSyncedBuiltin } from "../../../src/ru-fork/mcp/McpCatalogBuilders.ts";
import { MCP_BUILTINS } from "../../../src/ru-fork/mcp/mcpBuiltinDefinitions.ts";
import {
  backfillServerMetadataEffect,
  pruneOrphanedVarValuesEffect,
  reconcileBuiltinsWith,
} from "../../../src/ru-fork/mcp/McpReactor.ts";

const ISO = "2026-01-01T00:00:00.000Z";

// Every internal dispatch dies ⇒ the reactor's `catchCause` arms must absorb it and keep going.
const failingEngine = {
  readEvents: () => Effect.die("readEvents is unused in this test"),
  dispatch: () => Effect.die("injected dispatch failure"),
  streamDomainEvents: Stream.empty,
} satisfies OrchestrationEngineShape;

const fakeCatalog = (servers: ReadonlyArray<McpCatalogServer>) =>
  ({
    listAll: () => Effect.succeed(servers),
    upsert: () => Effect.die("upsert is unused in this test"),
    remove: () => Effect.die("remove is unused in this test"),
  }) satisfies McpCatalogRepositoryShape;

const fakeBinding = (bindings: ReadonlyArray<ReturnType<typeof buildBinding>>) =>
  ({
    listAll: () => Effect.succeed(bindings),
    upsert: () => Effect.die("upsert is unused in this test"),
    remove: () => Effect.die("remove is unused in this test"),
    listByProject: () => Effect.die("listByProject is unused in this test"),
    removeByProject: () => Effect.die("removeByProject is unused in this test"),
    removeByServer: () => Effect.die("removeByServer is unused in this test"),
  }) satisfies McpBindingRepositoryShape;

const fakeProbeCache = (record: McpProbeRecord) =>
  ({
    getByKey: () => Effect.succeed(Option.some(record)),
    upsert: () => Effect.die("upsert is unused in this test"),
    deleteKeysNotIn: () => Effect.die("deleteKeysNotIn is unused in this test"),
  }) satisfies McpProbeCacheRepositoryShape;

const stdioConfig = (id: string) => ({ transport: "stdio" as const, command: "uvx", args: [id] });

// Run `effect` (already fully provided except logging + the Crypto service the reactor's
// commandId minting now needs) and capture every emitted log entry.
async function runCapturingLogs(effect: Effect.Effect<unknown, never, Crypto.Crypto>) {
  const captured: Array<{ readonly level: string; readonly message: string }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    captured.push({ level: String(logLevel), message: String(message) });
  });
  await Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  return captured;
}

const loggedError = (captured: ReadonlyArray<{ level: string; message: string }>, needle: string) =>
  // The needle messages are only ever emitted via `Effect.logError` in the reactor arms, so matching the
  // message proves the arm fired; we also confirm it was at error level (tolerant of "Error"/"ERROR").
  captured.some(
    (entry) => entry.message.includes(needle) && entry.level.toUpperCase().includes("ERROR"),
  );

describe("McpReactor hygiene catch arms are live (log + continue on a failed dispatch)", () => {
  it("sync arm: a failed builtin-sync dispatch is logged and the reconcile completes", async () => {
    // Empty catalog ⇒ every shipped built-in needs syncing ⇒ a dispatch is attempted (and dies).
    const captured = await runCapturingLogs(
      reconcileBuiltinsWith(MCP_BUILTINS, process.platform).pipe(
        Effect.provideService(OrchestrationEngineService, failingEngine),
        Effect.provideService(McpCatalogRepository, fakeCatalog([])),
      ),
    );
    expect(loggedError(captured, "sync builtin")).toBe(true); // completing AND logging proves the arm is live
  });

  it("remove arm: a failed dropped-builtin remove dispatch is logged and the reconcile completes", async () => {
    const ghost = buildSyncedBuiltin({
      serverId: McpServerId.make("server:mcp:ghost"),
      builtinId: "ghost",
      builtinHash: "h",
      name: "ghost",
      description: null,
      websiteUrl: null,
      config: stdioConfig("ghost"),
      shippedVars: [],
      timeoutMs: null,
      existing: undefined,
      occurredAt: ISO,
    });
    // Nothing shipped ⇒ the installed `ghost` built-in is dropped ⇒ a remove is dispatched (and dies).
    const captured = await runCapturingLogs(
      reconcileBuiltinsWith([], process.platform).pipe(
        Effect.provideService(OrchestrationEngineService, failingEngine),
        Effect.provideService(McpCatalogRepository, fakeCatalog([ghost])),
      ),
    );
    expect(loggedError(captured, "remove dropped builtin")).toBe(true);
  });

  it("backfill arm: a failed metadata-backfill dispatch is logged and the pass completes", async () => {
    const server = buildAddedServer(
      McpServerId.make("s-bf"),
      { name: "s-bf", config: stdioConfig("s-bf"), vars: [], timeoutMs: null },
      [],
      ISO,
    ); // description + websiteUrl both null ⇒ backfill proceeds
    const probe: McpProbeRecord = {
      configKey: "ck-bf",
      transport: "stdio",
      status: "online",
      tools: [],
      lastError: null,
      serverDescription: "Probed description",
      serverWebsiteUrl: null,
      checkedAt: IsoDateTime.make(ISO),
      checkedAtMs: 1,
    };
    const captured = await runCapturingLogs(
      backfillServerMetadataEffect.pipe(
        Effect.provideService(OrchestrationEngineService, failingEngine),
        Effect.provideService(McpCatalogRepository, fakeCatalog([server])),
        Effect.provideService(McpProbeCacheRepository, fakeProbeCache(probe)),
      ),
    );
    expect(loggedError(captured, "backfill server metadata")).toBe(true);
  });

  it("prune arm: a failed orphan-var prune dispatch is logged and the scan completes", async () => {
    const server = buildAddedServer(
      McpServerId.make("s-pr"),
      { name: "s-pr", config: stdioConfig("s-pr"), vars: [], timeoutMs: null },
      [],
      ISO,
    ); // declares NO vars
    const binding = buildBinding({
      projectId: ProjectId.make("p"),
      serverId: McpServerId.make("s-pr"),
      patch: { enabled: true },
      existing: undefined,
      varValues: { ORPHAN: "stranded-value" }, // a value for a var the server no longer declares
      occurredAt: ISO,
    });
    const captured = await runCapturingLogs(
      pruneOrphanedVarValuesEffect.pipe(
        Effect.provideService(OrchestrationEngineService, failingEngine),
        Effect.provideService(McpCatalogRepository, fakeCatalog([server])),
        Effect.provideService(McpBindingRepository, fakeBinding([binding])),
      ),
    );
    expect(loggedError(captured, "prune orphaned var values")).toBe(true);
  });
});
