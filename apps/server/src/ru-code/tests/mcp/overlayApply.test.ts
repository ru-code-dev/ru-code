// ru-code: behavior tests for the qwen settings overlay (McpOverlay.resolveOverlay +
// writeResolvedOverlay / removeOverlay) — the file qwen actually reads. Drives the REAL engine to
// populate catalog + bindings, resolves+writes the overlay to a temp dir, reads it back, and
// asserts the JSON qwen will see: which servers are included (enabled / not-disabled / complete),
// the stdio/http entry shape, secret materialization into env, tool-policy include/excludeTools,
// folderTrust off, and the empty-overlay / remove paths.

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpOverlay,
  McpOverlayLive,
  McpServerId,
  type McpServerVarDraft,
  type McpToolPolicy,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

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

const ISO = "2026-01-01T00:00:00.000Z";

function projectCreate(
  projectId: string,
  workspaceRoot: string,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    title: "P",
    workspaceRoot,
    createdAt: ISO,
  };
}

function addStdio(
  serverId: string,
  name: string,
  args: ReadonlyArray<string>,
  vars: ReadonlyArray<McpServerVarDraft>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    draft: {
      name,
      config: { transport: "stdio", command: "uvx", args: [...args] },
      vars,
      timeoutMs: null,
    },
    createdAt: ISO,
  };
}

function addHttp(
  serverId: string,
  name: string,
  httpUrl: string,
  headers: Record<string, string>,
  vars: ReadonlyArray<McpServerVarDraft>,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-add",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    draft: { name, config: { transport: "http", httpUrl, headers }, vars, timeoutMs: null },
    createdAt: ISO,
  };
}

function setServerEnabled(
  serverId: string,
  enabled: boolean,
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.server-update",
    commandId: CommandId.make(commandId),
    serverId: McpServerId.make(serverId),
    patch: { enabled },
  };
}

function bind(
  projectId: string,
  serverId: string,
  patch: { enabled?: boolean; varValues?: Record<string, string>; toolPolicy?: McpToolPolicy },
  commandId: string,
): OrchestrationCommand {
  return {
    type: "mcp.binding-set",
    commandId: CommandId.make(commandId),
    projectId: ProjectId.make(projectId),
    serverId: McpServerId.make(serverId),
    patch: {
      enabled: patch.enabled ?? true,
      ...(patch.varValues ? { varValues: patch.varValues } : {}),
      ...(patch.toolPolicy ? { toolPolicy: patch.toolPolicy } : {}),
    },
  };
}

interface OverlayJson {
  readonly security: { readonly folderTrust: { readonly enabled: boolean } };
  readonly mcpServers: Record<string, Record<string, unknown>>;
}

function makeSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-overlay-test-",
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
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(McpOverlayLive.pipe(Layer.provideMerge(base)));
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(OrchestrationEngineService), (engine) =>
          engine.dispatch(command),
        ),
      ),
    // resolve→write composed — the split API's full path (what writeForSpawn does for ≥1 server).
    writeOverlay: (projectId: string) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay
            .resolveOverlay(ProjectId.make(projectId))
            .pipe(Effect.tap((resolution) => overlay.writeResolvedOverlay(resolution))),
        ),
      ),
    removeOverlay: (projectId: string) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay.removeOverlay(ProjectId.make(projectId)),
        ),
      ),
    deleteOverlayFile: (overlayPath: string) =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) =>
          overlay.deleteOverlayFile(overlayPath),
        ),
      ),
    removeAllOverlays: () =>
      runtime.runPromise(
        Effect.flatMap(Effect.service(McpOverlay), (overlay) => overlay.removeAllOverlays),
      ),
    readOverlay: (path: string): Promise<OverlayJson> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const text = yield* fs.readFileString(path);
          // @effect-diagnostics-next-line preferSchemaOverJson:off - test-only read-back of the overlay file.
          return JSON.parse(text) as OverlayJson;
        }),
      ),
    fileExists: (path: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(path);
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}

describe("McpOverlay.writeOverlay — the qwen settings file", () => {
  let system: ReturnType<typeof makeSystem>;
  beforeEach(() => {
    system = makeSystem();
  });
  afterEach(async () => {
    await system.dispose();
  });

  it("writes an enabled stdio binding with resolved command/args/env/cwd/timeout + folderTrust off", async () => {
    await system.dispatch(projectCreate("p1", "/work/p1", "pc:1"));
    await system.dispatch(addStdio("s-fs", "fs", ["--root", "${PROJECT_CWD}"], [], "add:fs"));
    await system.dispatch(bind("p1", "s-fs", {}, "bind:fs"));

    const result = await system.writeOverlay("p1");
    expect(result.allowedServerNames).toEqual(["s-fs"]);
    const json = await system.readOverlay(result.overlayPath);
    expect(json.security.folderTrust.enabled).toBe(false);
    const entry = json.mcpServers["s-fs"]!;
    expect(entry).toMatchObject({
      command: "uvx",
      args: ["--root", "/work/p1"], // ${PROJECT_CWD} expanded
      cwd: "/work/p1",
    });
    expect(entry.timeout).toBeTypeOf("number");
  });

  it("materializes a per-project secret value into the entry's env", async () => {
    await system.dispatch(projectCreate("p2", "/work/p2", "pc:2"));
    await system.dispatch(
      addStdio(
        "s-sec",
        "sec",
        [],
        [{ name: "TOKEN", secret: true, perProject: true, required: true, value: null }],
        "add:sec",
      ),
    );
    await system.dispatch(bind("p2", "s-sec", { varValues: { TOKEN: "s3cr3t" } }, "bind:sec"));

    const result = await system.writeOverlay("p2");
    const env = (await system.readOverlay(result.overlayPath)).mcpServers["s-sec"]!.env as Record<
      string,
      string
    >;
    expect(env.TOKEN).toBe("s3cr3t"); // ref → plaintext, isolated in this entry
  });

  it("excludes a DISABLED binding, a CATALOG-disabled server, and an INCOMPLETE binding", async () => {
    await system.dispatch(projectCreate("p3", "/work/p3", "pc:3"));
    // ru-code #2: distinct configs (identity is the config) — each server uses different args.
    // (a) disabled binding
    await system.dispatch(addStdio("s-off", "off", ["off"], [], "add:off"));
    await system.dispatch(bind("p3", "s-off", { enabled: false }, "bind:off"));
    // (b) catalog-disabled server
    await system.dispatch(addStdio("s-cat", "cat", ["cat"], [], "add:cat"));
    await system.dispatch(bind("p3", "s-cat", {}, "bind:cat"));
    await system.dispatch(setServerEnabled("s-cat", false, "dis:cat"));
    // (c) incomplete: required per-project var left unfilled
    await system.dispatch(
      addStdio(
        "s-inc",
        "inc",
        ["inc"],
        [{ name: "NEED", secret: false, perProject: true, required: true, value: null }],
        "add:inc",
      ),
    );
    await system.dispatch(bind("p3", "s-inc", {}, "bind:inc"));
    // (d) a good one, to prove the overlay is otherwise non-empty
    await system.dispatch(addStdio("s-ok", "ok", ["ok"], [], "add:ok"));
    await system.dispatch(bind("p3", "s-ok", {}, "bind:ok"));

    const result = await system.writeOverlay("p3");
    expect(result.allowedServerNames).toEqual(["s-ok"]);
    const json = await system.readOverlay(result.overlayPath);
    expect(Object.keys(json.mcpServers)).toEqual(["s-ok"]);
  });

  it("writes an http binding as httpUrl/headers with ${VAR} expanded", async () => {
    await system.dispatch(projectCreate("p4", "/work/p4", "pc:4"));
    await system.dispatch(
      addHttp(
        "s-http",
        "http",
        "https://${HOST}/mcp",
        { Authorization: "Bearer ${TOKEN}" },
        [
          {
            name: "HOST",
            secret: false,
            perProject: false,
            required: true,
            value: "api.example.com",
          },
          { name: "TOKEN", secret: true, perProject: true, required: true, value: null },
        ],
        "add:http",
      ),
    );
    await system.dispatch(bind("p4", "s-http", { varValues: { TOKEN: "abc" } }, "bind:http"));

    const result = await system.writeOverlay("p4");
    const entry = (await system.readOverlay(result.overlayPath)).mcpServers["s-http"]!;
    expect(entry.httpUrl).toBe("https://api.example.com/mcp");
    expect(entry.headers).toEqual({ Authorization: "Bearer abc" });
    expect("env" in entry).toBe(false);
  });

  it("derives include/excludeTools from the tool POLICY (not discovered tools)", async () => {
    await system.dispatch(projectCreate("p5", "/work/p5", "pc:5"));
    // ru-code #2: distinct configs (identity is the config) — args differ so both servers can be added.
    await system.dispatch(addStdio("s-deny", "deny", ["deny"], [], "add:deny"));
    await system.dispatch(
      bind(
        "p5",
        "s-deny",
        { toolPolicy: { defaultDecision: "deny", exceptions: ["read"] } },
        "bind:deny",
      ),
    );
    await system.dispatch(addStdio("s-allow", "allow", ["allow"], [], "add:allow"));
    await system.dispatch(
      bind(
        "p5",
        "s-allow",
        { toolPolicy: { defaultDecision: "allow", exceptions: ["danger"] } },
        "bind:allow",
      ),
    );

    const json = await system.readOverlay((await system.writeOverlay("p5")).overlayPath);
    expect(json.mcpServers["s-deny"]!.includeTools).toEqual(["read"]);
    expect(json.mcpServers["s-deny"]!.excludeTools).toBeUndefined();
    expect(json.mcpServers["s-allow"]!.excludeTools).toEqual(["danger"]);
    expect(json.mcpServers["s-allow"]!.includeTools).toBeUndefined();
    // ru-code #6: every server entry carries qwen's `trust` flag (default true).
    expect(json.mcpServers["s-deny"]!.trust).toBe(true);
  });

  it("a project with no shell (no cwd) writes an empty mcpServers overlay", async () => {
    // No project.create for 'ghost' ⇒ getProjectShellById is None ⇒ projectCwd null ⇒ empty overlay.
    const result = await system.writeOverlay("ghost");
    expect(result.allowedServerNames).toEqual([]);
    const json = await system.readOverlay(result.overlayPath);
    expect(json.mcpServers).toEqual({});
    expect(json.security.folderTrust.enabled).toBe(false);
  });

  it("removeOverlay deletes the project's overlay file", async () => {
    await system.dispatch(projectCreate("p6", "/work/p6", "pc:6"));
    await system.dispatch(addStdio("s-r", "r", [], [], "add:r"));
    await system.dispatch(bind("p6", "s-r", {}, "bind:r"));
    const result = await system.writeOverlay("p6");
    expect(await system.fileExists(result.overlayPath)).toBe(true);

    await system.removeOverlay("p6");
    expect(await system.fileExists(result.overlayPath)).toBe(false);
  });

  // ── ru-code #4: ephemeral-overlay leaf ops (used by the spawn finalizer + sweeps) ──

  it("G12 — deleteOverlayFile removes one overlay file and is a no-op when absent", async () => {
    await system.dispatch(projectCreate("p7", "/work/p7", "pc:7"));
    await system.dispatch(addStdio("s-d", "d", [], [], "add:d"));
    await system.dispatch(bind("p7", "s-d", {}, "bind:d"));
    const result = await system.writeOverlay("p7");
    expect(await system.fileExists(result.overlayPath)).toBe(true);

    await system.deleteOverlayFile(result.overlayPath);
    expect(await system.fileExists(result.overlayPath)).toBe(false);
    // Must NOT throw on a missing file (it runs inside Effect.ensuring).
    await system.deleteOverlayFile(result.overlayPath);
  });

  it("G10 — removeAllOverlays sweeps EVERY project's overlay file", async () => {
    await system.dispatch(projectCreate("pa", "/work/pa", "pc:a"));
    await system.dispatch(addStdio("s-a", "a", ["a"], [], "add:a"));
    await system.dispatch(bind("pa", "s-a", {}, "bind:a"));
    await system.dispatch(projectCreate("pb", "/work/pb", "pc:b"));
    await system.dispatch(addStdio("s-b", "b", ["b"], [], "add:b"));
    await system.dispatch(bind("pb", "s-b", {}, "bind:b"));

    const a = await system.writeOverlay("pa");
    const b = await system.writeOverlay("pb");
    expect(await system.fileExists(a.overlayPath)).toBe(true);
    expect(await system.fileExists(b.overlayPath)).toBe(true);

    await system.removeAllOverlays();
    expect(await system.fileExists(a.overlayPath)).toBe(false);
    expect(await system.fileExists(b.overlayPath)).toBe(false);
  });
});
