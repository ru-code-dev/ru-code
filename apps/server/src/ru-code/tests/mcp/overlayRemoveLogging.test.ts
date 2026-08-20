// ru-code: McpOverlay.removeOverlay error-path. It runs `fileSystem.remove(overlayDir, {recursive})`
// and currently `.pipe(Effect.ignore)`s the result — so a failed removal of a project's overlay dir
// (which holds RESOLVED SECRET values, mode 0600) vanishes with zero signal. The intended behavior is
// best-effort but OBSERVABLE: don't fail the project.deleted chain, but logError the failure. We inject
// a guaranteed `remove` failure via a FileSystem override, and a control probe proves the override is
// actually wired (so the "no log" assertion can't be red for the wrong reason). RED until the swallow
// is replaced with a logged catch.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpOverlay, McpOverlayLive } from "@smart-tools/qwen-cli-mcp-manager/server";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { layer as ServerSecretStoreLayer } from "../../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
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

interface CapturedLog {
  readonly level: string;
  readonly message: string;
}

// A FileSystem whose `remove` always fails (everything else is the real implementation).
const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Injected remove failure.${options ? " recursive" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

function makeSystem() {
  const captured: Array<CapturedLog> = [];
  const captureLogger = Logger.make(({ logLevel, message }) => {
    captured.push({ level: String(logLevel), message: String(message) });
  });
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-rm-test-" });
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
  const runtime = ManagedRuntime.make(
    McpOverlayLive.pipe(
      // RemoveFailureFileSystemLayer must be the INNER provide so McpOverlay binds ITS FileSystem to the
      // failing one (a later provideMerge wouldn't win — McpOverlay would bind to base's real NodeServices FS).
      Layer.provideMerge(RemoveFailureFileSystemLayer),
      Layer.provideMerge(base),
      Layer.provideMerge(Logger.layer([captureLogger], { mergeWithExisting: false })),
      Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")), // capture logDebug
    ),
  );
  return {
    // Control probe: confirms the failing-remove override is actually in effect for this runtime.
    removeFails: () =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fileSystem) =>
          Effect.exit(fileSystem.remove("/tmp/t3-control-probe", { recursive: true })),
        ),
      ),
    removeOverlay: (projectId: string) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay.removeOverlay(ProjectId.make(projectId)),
        ),
      ),
    captured,
    dispose: () => runtime.dispose(),
  };
}

describe("McpOverlay.removeOverlay error path", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("does not fail the caller, but LOGS when removing a project's overlay fails", async () => {
    // Control: the override is wired ⇒ remove genuinely fails for this runtime.
    expect(Exit.isFailure(await system.removeFails())).toBe(true);

    // removeOverlay must NOT fail the project.deleted chain even though remove fails.
    await expect(system.removeOverlay("any-project")).resolves.toBeUndefined();

    // EXPECTED: best-effort but observable at debug. Current `Effect.ignore` emits nothing ⇒ RED until
    // the swallow becomes a logDebug.
    const overlayLog = system.captured.find((entry) =>
      entry.message.toLowerCase().includes("overlay"),
    );
    expect(overlayLog).toBeDefined();
    expect(overlayLog?.level.toUpperCase()).toContain("DEBUG");
  });
});
