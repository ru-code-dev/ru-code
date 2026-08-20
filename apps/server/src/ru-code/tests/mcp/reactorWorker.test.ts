// @effect-diagnostics nodeBuiltinImport:off
// ru-code: integration tests for the McpReactor WORKER + START lifecycle — the live wiring that the
// per-effect seam tests (reactorEffects/reconciliationLifecycle) deliberately bypass. Here we stand up
// the WHOLE reactor (engine → projections → supervisor → overlay → reactor) and drive it through REAL
// domain events, asserting the assembled behaviour:
//   - start() seeds built-ins and does the initial reconcile WITHOUT probing on load;
//   - a post-startup mcp.* event flows engine → streamDomainEvents → worker → reconcileNow →
//     probeHashes and the new instance actually goes ONLINE (the full interaction chain);
//   - project.created drives autobind through the worker (gated by settings);
//   - reconcileNow's probe-cache GC prunes orphaned rows;
//   - project.deleted reconciles the deleted project's ref away.
// Probes use the local fake stdio MCP server; the shipped built-ins are kept un-probed (left unbound, or
// catalog-disabled) so no npx/network probe is ever triggered — the suite stays hermetic and fast.

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  builtinConfigForPlatform,
  builtinServerId,
  MCP_BUILTINS,
  McpBindingRepository,
  McpOverlayLive,
  McpProbeCacheRepository,
  McpReactor,
  McpReactorLive,
  McpServerId,
  McpSupervisor,
  McpSupervisorLive,
} from "@smart-tools/qwen-cli-mcp-manager/server";
import { CommandId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
import { ServerSettingsService } from "../../../serverSettings.ts";
// ru-code: t3 added the shared background-liveness + plan-progress registries to the
// orchestration infrastructure layer; hand-composed engine graphs must provide them.
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import {
  mcpConfigLayer,
  mcpEngineLayer,
  mcpProjectsLayer,
  mcpSecretStoreLayer,
  mcpSettingsLayer,
} from "../../mcp/mcpPorts.ts";

const ISO = "2026-01-01T00:00:00.000Z";

// ru-code: the built-in ids that reconcileBuiltins will actually seed on THIS platform (a definition
// with no variant for the current OS is skipped). Derived from the shipped list so these tests track
// edits to mcpBuiltinDefinitions.ts (add/remove/rename a built-in) instead of hard-coding names/counts.
const SEEDED_BUILTIN_IDS = MCP_BUILTINS.filter(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- ru-code: mirrors production (McpReactor passes process.platform to the builtin migrator); injecting HostProcessPlatform would diverge the ported suite
  (definition) => builtinConfigForPlatform(definition, process.platform) !== null,
).map((definition) => definition.builtinId);

// fixtures/fakeMcpStdioServer.mjs — real stdio MCP server (echo + ping).
const FAKE_SERVER = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../fixtures/fakeMcpStdioServer.mjs",
);

const addFakeServer = (
  serverId: string,
  extraArgs: ReadonlyArray<string> = [],
): OrchestrationCommand => ({
  type: "mcp.server-add",
  commandId: CommandId.make(`cmd-add-${serverId}-${extraArgs.join("_")}`),
  serverId: McpServerId.make(serverId),
  draft: {
    name: serverId,
    config: { transport: "stdio", command: "node", args: [FAKE_SERVER, ...extraArgs] },
    vars: [],
    timeoutMs: 10_000,
  },
  createdAt: ISO,
});

const updateConfig = (
  serverId: string,
  extraArgs: ReadonlyArray<string>,
): OrchestrationCommand => ({
  type: "mcp.server-update",
  commandId: CommandId.make(`cmd-cfg-${serverId}-${extraArgs.join("_")}`),
  serverId: McpServerId.make(serverId),
  patch: { config: { transport: "stdio", command: "node", args: [FAKE_SERVER, ...extraArgs] } },
});

const setEnabled = (serverId: string, enabled: boolean): OrchestrationCommand => ({
  type: "mcp.server-update",
  commandId: CommandId.make(`cmd-en-${serverId}-${enabled}`),
  serverId: McpServerId.make(serverId),
  patch: { enabled },
});

const createProject = (projectId: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make(`cmd-proj-${projectId}`),
  projectId: ProjectId.make(projectId),
  title: "P",
  workspaceRoot: `/tmp/${projectId}`,
  createdAt: ISO,
});

const deleteProject = (projectId: string): OrchestrationCommand => ({
  type: "project.delete",
  commandId: CommandId.make(`cmd-projdel-${projectId}`),
  projectId: ProjectId.make(projectId),
});

const bindServer = (projectId: string, serverId: string): OrchestrationCommand => ({
  type: "mcp.binding-set",
  commandId: CommandId.make(`cmd-bind-${projectId}-${serverId}`),
  projectId: ProjectId.make(projectId),
  serverId: McpServerId.make(serverId),
  patch: { enabled: true },
});

// Poll `query` until `predicate` holds (or fail loudly). Used instead of `drain` because the
// engine→stream→worker hop is asynchronous: drain can observe an empty queue before the forked
// subscription has even enqueued the work.
const waitUntil = <A, E>(query: Effect.Effect<A, E>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 240; attempt++) {
      const value = yield* query;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(new Error("waitUntil: condition not satisfied within timeout"));
  });

function makeSystem(settings: DeepPartial<ServerSettings> = {}) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-mcp-reactor-test-",
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
  const base = Layer.mergeAll(
    mcpConfigLayer,
    mcpEngineLayer,
    mcpProjectsLayer,
    mcpSettingsLayer,
  ).pipe(
    Layer.provideMerge(engineBase),
    Layer.provideMerge(ServerSecretStoreLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
  );
  const withSupervisor = McpSupervisorLive.pipe(Layer.provideMerge(base));
  const withOverlay = McpOverlayLive.pipe(Layer.provideMerge(withSupervisor));
  const reactorLayer = McpReactorLive.pipe(Layer.provideMerge(withOverlay));
  // ru-code: the harness services the scoped body may reach (typed, so no unsafe casts — these
  // suites typecheck in ng, unlike the transpile-only legacy tests dir).
  type SystemServices = Layer.Success<typeof reactorLayer>;
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- ru-code: 1:1 port of the legacy MCP engine harness (same baselined pattern as OrchestrationEngine.test.ts); rewriting to it.effect would fork the suite from its legacy source
  const runtime = ManagedRuntime.make(reactorLayer);
  return {
    // Run a scoped body with the whole reactor in context (start()'s subscription lives for the body).
    run: <A, E>(body: Effect.Effect<A, E, SystemServices | Scope.Scope>): Promise<A> =>
      runtime.runPromise(Effect.scoped(body)),
    dispose: () => runtime.dispose(),
  };
}

describe("McpReactor worker + start lifecycle (integration)", () => {
  let system: ReturnType<typeof makeSystem>;
  afterEach(async () => {
    await system.dispose();
  });

  it("start() seeds built-ins + reconciles WITHOUT probing on load (no eager probe at startup)", async () => {
    system = makeSystem();
    const result = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const supervisor = yield* McpSupervisor;

        // A complete custom server present BEFORE start: it must be registered by the initial reconcile
        // but NOT probed (load-time reconcile is non-eager).
        yield* engine.dispatch(addFakeServer("srv-load"));
        yield* reactor.start();

        // Wait until the initial reconcile has registered our server, then assert nothing was probed.
        const instances = yield* waitUntil(supervisor.currentInstances, (all) =>
          all.some((i) => i.refs.has("catalog:srv-load")),
        );
        const inFlight = yield* supervisor.currentInFlight;
        return { instances, inFlight };
      }),
    );

    // Every registered instance is still «unchecked» — the load-time reconcile probed none of them.
    expect(result.instances.length).toBeGreaterThan(0);
    expect(result.instances.every((i) => i.status === "unchecked")).toBe(true);
    expect(result.inFlight.size).toBe(0);
    // The shipped built-ins were seeded into the catalog by start() (at least one complete built-in
    // registers a catalog instance — derived from the shipped list, not a hard-coded name).
    expect(
      SEEDED_BUILTIN_IDS.some((builtinId) =>
        result.instances.some((instance) =>
          instance.refs.has(`catalog:${builtinServerId(builtinId)}`),
        ),
      ),
    ).toBe(true);
  }, 25_000);

  it("a post-startup server-add flows engine → stream → worker → probe and goes ONLINE", async () => {
    system = makeSystem();
    const online = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const supervisor = yield* McpSupervisor;

        yield* reactor.start();
        // Drain the startup reconcile first (so the only eager change below is our new server).
        yield* reactor.drain;

        // The crown-jewel path: a genuine post-startup change must auto-probe the NEW instance.
        yield* engine.dispatch(addFakeServer("srv-live"));
        const instances = yield* waitUntil(supervisor.currentInstances, (all) =>
          all.some((i) => i.refs.has("catalog:srv-live") && i.status === "online"),
        );
        return instances.find((i) => i.refs.has("catalog:srv-live"));
      }),
    );

    expect(online?.status).toBe("online");
    expect(online?.discoveredTools.map((tool) => tool.name).toSorted()).toEqual(["echo", "ping"]);
    expect(typeof online?.latencyMs).toBe("number");
  }, 25_000);

  it("project.created autobinds every built-in through the worker when autobindDefaults is ON", async () => {
    // Disable EVERY shipped built-in first so their autobound (enabled) bindings don't trigger real
    // npx/http probes — we're asserting the WIRING (one enabled binding per built-in), not probe
    // outcomes. The set is derived from MCP_BUILTINS, so this stays correct when the list changes.
    system = makeSystem({ mcp: { autobindDefaults: true } });
    const expectedBuiltinCount = SEEDED_BUILTIN_IDS.length;
    const bindings = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const bindingRepository = yield* McpBindingRepository;

        yield* reactor.start();
        yield* reactor.drain;
        yield* Effect.forEach(SEEDED_BUILTIN_IDS, (builtinId) =>
          engine.dispatch(setEnabled(builtinServerId(builtinId), false)),
        );
        yield* reactor.drain;

        yield* engine.dispatch(createProject("proj-ab"));
        return yield* waitUntil(
          bindingRepository.listByProject({ projectId: ProjectId.make("proj-ab") }),
          (rows) => rows.length >= expectedBuiltinCount,
        );
      }),
    );

    // Every shipped (platform-supported) built-in is autobound, enabled.
    expect(bindings.length).toBe(expectedBuiltinCount);
    expect(bindings.every((binding) => binding.enabled)).toBe(true);
  }, 25_000);

  it("project.created does NOT autobind when autobindDefaults is OFF (default)", async () => {
    system = makeSystem(); // autobindDefaults defaults to false
    const bindings = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const bindingRepository = yield* McpBindingRepository;

        yield* reactor.start();
        yield* reactor.drain;
        yield* engine.dispatch(createProject("proj-noab"));
        yield* reactor.drain;
        // Give the worker a beat; then assert no bindings ever appear for the project.
        yield* Effect.sleep("150 millis");
        return yield* bindingRepository.listByProject({ projectId: ProjectId.make("proj-noab") });
      }),
    );
    expect(bindings).toEqual([]);
  }, 25_000);

  it("reconcileNow GCs the orphaned probe-cache row after a server's config changes", async () => {
    system = makeSystem();
    const result = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const supervisor = yield* McpSupervisor;
        const probeCache = yield* McpProbeCacheRepository;

        yield* reactor.start();
        yield* reactor.drain;

        // Probe srv-gc online ⇒ a cache row is written for its current configKey.
        yield* engine.dispatch(addFakeServer("srv-gc"));
        const before = yield* waitUntil(supervisor.currentInstances, (all) =>
          all.some((i) => i.refs.has("catalog:srv-gc") && i.status === "online"),
        );
        const oldConfigKey = before.find((i) => i.refs.has("catalog:srv-gc"))!.configKey;
        const rowBefore = yield* probeCache.getByKey({ configKey: oldConfigKey });

        // Change the config ⇒ new configKey; the old row is now orphaned and must be GC'd on reconcile
        // (desired is still non-empty thanks to the shipped built-ins, so the delete path runs).
        yield* engine.dispatch(updateConfig("srv-gc", ["--variant"]));
        yield* waitUntil(probeCache.getByKey({ configKey: oldConfigKey }), Option.isNone);
        return { rowBefore };
      }),
    );
    expect(Option.isSome(result.rowBefore)).toBe(true); // the row existed before the config change
    // (the waitUntil above already proved it is gone after — reaching here means GC ran)
  }, 25_000);

  it("project.deleted reconciles the deleted project's ref away (binding cascade)", async () => {
    system = makeSystem();
    const refsAfter = await system.run(
      Effect.gen(function* () {
        const reactor = yield* McpReactor;
        const engine = yield* OrchestrationEngineService;
        const supervisor = yield* McpSupervisor;

        yield* reactor.start();
        yield* reactor.drain;

        yield* engine.dispatch(addFakeServer("srv-del"));
        yield* engine.dispatch(createProject("proj-del"));
        yield* engine.dispatch(bindServer("proj-del", "srv-del"));
        // The binding adds the `proj-del:srv-del` ref onto the shared instance.
        yield* waitUntil(supervisor.currentInstances, (all) =>
          all.some((i) => i.refs.has("proj-del:srv-del")),
        );

        // Delete the project ⇒ binding cascades away ⇒ reconcile drops the project ref.
        yield* engine.dispatch(deleteProject("proj-del"));
        const instances = yield* waitUntil(supervisor.currentInstances, (all) =>
          all.every((i) => !i.refs.has("proj-del:srv-del")),
        );
        // The instance survives via its catalog ref (the server itself wasn't removed).
        return instances.find((i) => i.refs.has("catalog:srv-del"))?.refs;
      }),
    );
    expect(refsAfter).toBeDefined();
    expect([...(refsAfter ?? [])]).toContain("catalog:srv-del");
    expect([...(refsAfter ?? [])]).not.toContain("proj-del:srv-del");
  }, 25_000);
});
