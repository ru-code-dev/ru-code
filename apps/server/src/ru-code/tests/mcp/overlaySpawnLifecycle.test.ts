// ru-code: full-flow contract of "write the overlay ⇔ (spawn OR respawn) AND ≥1 enabled
// server" over the REAL package services (McpOverlay + McpSessionOverlay) and the REAL
// engine: fresh spawn writes the file and the region-settle cleanup removes it; a reuse
// turn performs zero disk I/O; disabling ALL servers still trips the respawn diff but the
// respawn is a clean no-MCP spawn (no file); re-enabling trips it again WITH the file.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpOverlayLive,
  McpServerId,
  McpSessionOverlay,
  McpSessionOverlayLive,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { assert, describe, it } from "@effect/vitest";

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
import {
  mcpConfigLayer,
  mcpEngineLayer,
  mcpProjectsLayer,
  mcpSecretStoreLayer,
} from "../../mcp/mcpPorts.ts";
import { makeMcpTurnOverlay } from "../../mcp/mcpTurnOverlay.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";

const ISO = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("p1");
const THREAD_ID = "t-lifecycle";

const projectCreate: OrchestrationCommand = {
  type: "project.create",
  commandId: CommandId.make("pc:1"),
  projectId: PROJECT_ID,
  title: "P",
  workspaceRoot: "/work/p1",
  createdAt: ISO,
};

const addServer: OrchestrationCommand = {
  type: "mcp.server-add",
  commandId: CommandId.make("add:srv"),
  serverId: McpServerId.make("srv"),
  draft: {
    name: "srv",
    config: { transport: "stdio", command: "uvx", args: ["srv"] },
    vars: [],
    timeoutMs: null,
  },
  createdAt: ISO,
};

const setBindingEnabled = (enabled: boolean, commandId: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(commandId),
  projectId: PROJECT_ID,
  serverId: McpServerId.make("srv"),
  patch: { enabled },
});

const makeTestLayer = () => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-turn-lifecycle-",
  });
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
  return McpSessionOverlayLive.pipe(Layer.provideMerge(McpOverlayLive), Layer.provideMerge(base));
};

describe("overlay spawn lifecycle — write ⇔ spawn AND ≥1 enabled server (real services)", () => {
  it.effect(
    "fresh spawn writes+cleans; reuse writes nothing; disable-all respawns fileless; re-enable respawns with file",
    () =>
      Effect.gen(function* () {
        const engine = yield* Effect.service(OrchestrationEngineService);
        const mcpSessionOverlay = yield* Effect.service(McpSessionOverlay);
        const fileSystem = yield* FileSystem.FileSystem;
        const newTurn = makeMcpTurnOverlay({
          mcpSessionOverlay,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
        });

        yield* engine.dispatch(projectCreate);
        yield* engine.dispatch(addServer);
        yield* engine.dispatch(setBindingEnabled(true, "bind:on-1"));

        // ── TURN 1: fresh spawn with 1 enabled server — file written, then cleaned ──
        const turn1 = yield* newTurn;
        assert.ok(turn1.fingerprint !== undefined, "resolution ran");
        let writtenPath = "";
        yield* turn1.withCleanup(
          Effect.gen(function* () {
            const fields = yield* turn1.overlayFieldsForSpawn("fresh-spawn");
            assert.ok("settingsOverlayPath" in fields, "spawn carries the overlay");
            writtenPath = fields.settingsOverlayPath;
            assert.deepStrictEqual(fields.allowedMcpServers, ["srv"]);
            assert.strictEqual(
              yield* fileSystem.exists(writtenPath),
              true,
              "file exists while the spawn region is live",
            );
            yield* turn1.recordSpawn;
          }),
        );
        assert.strictEqual(
          yield* fileSystem.exists(writtenPath),
          false,
          "file deleted at region settle",
        );

        // ── TURN 2: reuse — unchanged fingerprint, ZERO disk I/O ──
        const turn2 = yield* newTurn;
        assert.strictEqual(yield* turn2.overlayChanged, false, "nothing changed ⇒ no respawn");
        yield* turn2.logReuseSkip;
        yield* turn2.withCleanup(Effect.void);
        assert.strictEqual(
          yield* fileSystem.exists(writtenPath),
          false,
          "a reuse turn never re-creates the file",
        );

        // ── N→0: disable the only binding — respawn fires, but NO file is written ──
        yield* engine.dispatch(setBindingEnabled(false, "bind:off-1"));
        const turn3 = yield* newTurn;
        assert.strictEqual(yield* turn3.overlayChanged, true, "N→0 must respawn");
        yield* turn3.withCleanup(
          Effect.gen(function* () {
            const fields = yield* turn3.overlayFieldsForSpawn("respawn");
            assert.deepStrictEqual(fields, {}, "0-server respawn is a clean no-MCP spawn");
            assert.strictEqual(yield* fileSystem.exists(writtenPath), false, "no file written");
            yield* turn3.recordSpawn;
          }),
        );
        const recordedEmpty = yield* mcpSessionOverlay.spawnState(THREAD_ID);
        assert.strictEqual(recordedEmpty?.allowlistKey, "", "empty allowlist recorded");

        // ── TURN 4: the 0-server state is stable — quiet reuse ──
        const turn4 = yield* newTurn;
        assert.strictEqual(yield* turn4.overlayChanged, false, "0-server session reuses quietly");

        // ── 0→N: re-enable — respawn fires again WITH the file ──
        yield* engine.dispatch(setBindingEnabled(true, "bind:on-2"));
        const turn5 = yield* newTurn;
        assert.strictEqual(yield* turn5.overlayChanged, true, "0→N must respawn");
        yield* turn5.withCleanup(
          Effect.gen(function* () {
            const fields = yield* turn5.overlayFieldsForSpawn("respawn");
            assert.ok("settingsOverlayPath" in fields, "the re-enabled spawn carries the overlay");
            assert.strictEqual(yield* fileSystem.exists(fields.settingsOverlayPath), true);
            yield* turn5.recordSpawn;
          }),
        );
        assert.strictEqual(yield* fileSystem.exists(writtenPath), false, "cleaned again");
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
