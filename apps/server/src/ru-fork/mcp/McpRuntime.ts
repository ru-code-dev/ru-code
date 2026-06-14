// ru-fork: flattens supervisor instances into runtime snapshots for the UI — a
// per-(project,server) row for project bindings (joining each binding's tool
// policy with the instance's discovered tools) AND a per-server catalog row
// (from the catalog default's probe), so the Каталог tab shows status + tools
// even before a server is bound. Advisory only; the cache is the source of truth.

import {
  IsoDateTime,
  type McpCatalogRuntimeSnapshot,
  type McpRuntimeSnapshot,
  type McpRuntimeStreamEvent,
} from "@t3tools/contracts";
import { configCacheKey, effectiveAllowedTools } from "@ru-fork/mcp-core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { McpBindingRepository } from "../../persistence/Services/McpBinding.ts";
import { McpCatalogRepository } from "../../persistence/Services/McpCatalog.ts";
import { McpSupervisor, type SupervisorInstance } from "./McpSupervisor.ts";

const RUNTIME_DEBOUNCE = Duration.millis(200);

export interface McpRuntimeShape {
  /** Initial snapshot followed by debounced full-snapshot updates on every change. */
  readonly subscriptionStream: Stream.Stream<McpRuntimeStreamEvent>;
}

export class McpRuntime extends Context.Service<McpRuntime, McpRuntimeShape>()(
  "ru-fork/mcp/McpRuntime",
) {}

const instanceRefKey = (projectId: string, serverId: string): string => `${projectId}:${serverId}`;

const makeMcpRuntime = Effect.gen(function* () {
  const supervisor = yield* McpSupervisor;
  const bindingRepository = yield* McpBindingRepository;
  const catalogRepository = yield* McpCatalogRepository;

  const currentSnapshot: Effect.Effect<{
    readonly runtimes: ReadonlyArray<McpRuntimeSnapshot>;
    readonly catalogRuntimes: ReadonlyArray<McpCatalogRuntimeSnapshot>;
  }> = Effect.gen(function* () {
    const instances = yield* supervisor.currentInstances;
    const inFlight = yield* supervisor.currentInFlight;
    const bindings = yield* bindingRepository.listAll();
    const catalog = yield* catalogRepository.listAll();

    const instanceByRef = new Map<string, SupervisorInstance>();
    const instanceByConfigKey = new Map<string, SupervisorInstance>();
    for (const instance of instances) {
      instanceByConfigKey.set(instance.configKey, instance);
      for (const ref of instance.refs) {
        instanceByRef.set(ref, instance);
      }
    }

    const runtimes: McpRuntimeSnapshot[] = [];
    for (const binding of bindings) {
      if (!binding.enabled) {
        continue;
      }
      const instance = instanceByRef.get(instanceRefKey(binding.projectId, binding.serverId));
      if (!instance) {
        continue;
      }
      runtimes.push({
        projectId: binding.projectId,
        serverId: binding.serverId,
        status: instance.status,
        checking: inFlight.has(instance.hash),
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
        effectiveAllowedTools: effectiveAllowedTools(binding.toolPolicy, instance.discoveredTools),
      });
    }

    const catalogRuntimes: McpCatalogRuntimeSnapshot[] = [];
    for (const server of catalog) {
      // The catalog default's instance is keyed on the template + vars with NO
      // per-project values — matching the reactor's `catalog:<id>` desired entry.
      const instance = instanceByConfigKey.get(
        configCacheKey(server.config, server.vars, {}, server.extraArgs, server.extraHeaders),
      );
      if (!instance) {
        continue;
      }
      catalogRuntimes.push({
        serverId: server.id,
        status: instance.status,
        checking: inFlight.has(instance.hash),
        ...(instance.message !== null ? { message: instance.message } : {}),
        ...(instance.latencyMs !== null ? { latencyMs: instance.latencyMs } : {}),
        ...(instance.checkedAt !== null ? { checkedAt: IsoDateTime.make(instance.checkedAt) } : {}),
        discoveredTools: instance.discoveredTools,
      });
    }

    return { runtimes, catalogRuntimes };
  }).pipe(
    // ru-fork: a transient read failure must not crash the UI stream — return an empty snapshot, but log
    // it (a persistent failure shouldn't be masked as "no servers configured").
    Effect.catch((cause) =>
      Effect.logDebug("mcp runtime: snapshot read failed; returning empty", { cause }).pipe(
        Effect.as({ runtimes: [], catalogRuntimes: [] }),
      ),
    ),
  );

  const snapshotEvent = currentSnapshot.pipe(
    Effect.map(
      ({ runtimes, catalogRuntimes }): McpRuntimeStreamEvent => ({
        type: "snapshot",
        runtimes,
        catalogRuntimes,
      }),
    ),
  );

  const subscriptionStream: Stream.Stream<McpRuntimeStreamEvent> = Stream.concat(
    Stream.fromEffect(snapshotEvent),
    supervisor.changes.pipe(
      Stream.debounce(RUNTIME_DEBOUNCE),
      Stream.mapEffect(() => snapshotEvent),
    ),
  );

  return { subscriptionStream } satisfies McpRuntimeShape;
});

export const McpRuntimeLive = Layer.effect(McpRuntime, makeMcpRuntime);
