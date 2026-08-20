// ru-code: the MCP manager's read-state — effect atoms fed by the two server subscription
// streams (`subscribeMcpProjection` = authored catalog/bindings, `subscribeMcpRuntime` =
// live probe status/tools). Every stream event carries a FULL snapshot, so the derived
// atoms are pure replaces (no per-row reconciliation). The panel package consumes these
// through its web ports (see McpPanelHost); nothing here imports panel internals.

import type {
  McpBinding,
  McpCatalogRuntimeSnapshot,
  McpCatalogServer,
  McpRuntimeSnapshot,
} from "@smart-tools/qwen-cli-mcp-manager/contracts";
import { mcpRuntimeKey } from "@smart-tools/qwen-cli-mcp-manager/web";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

const EMPTY_CATALOG: ReadonlyArray<McpCatalogServer> = [];
const EMPTY_BINDINGS: ReadonlyArray<McpBinding> = [];
const EMPTY_RUNTIME_MAP: Readonly<Record<string, McpRuntimeSnapshot>> = {};
const EMPTY_CATALOG_RUNTIME_MAP: Readonly<Record<string, McpCatalogRuntimeSnapshot>> = {};

/** The two subscription atom families (latest stream event per environment). */
const mcpEnvironment = {
  projection: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "ru-code:mcp:projection",
    tag: "subscribeMcpProjection",
  }),
  runtime: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "ru-code:mcp:runtime",
    tag: "subscribeMcpRuntime",
  }),
} as const;

const mcpProjectionEventAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(get(mcpEnvironment.projection({ environmentId, input: {} }))),
  );
}).pipe(Atom.withLabel("ru-code:mcp:projection-event"));

const mcpRuntimeEventAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(get(mcpEnvironment.runtime({ environmentId, input: {} }))),
  );
}).pipe(Atom.withLabel("ru-code:mcp:runtime-event"));

export const mcpCatalogAtom = Atom.make(
  (get): ReadonlyArray<McpCatalogServer> =>
    get(mcpProjectionEventAtom)?.snapshot.catalog ?? EMPTY_CATALOG,
).pipe(Atom.withLabel("ru-code:mcp:catalog"));

export const mcpBindingsAtom = Atom.make(
  (get): ReadonlyArray<McpBinding> =>
    get(mcpProjectionEventAtom)?.snapshot.bindings ?? EMPTY_BINDINGS,
).pipe(Atom.withLabel("ru-code:mcp:bindings"));

export const mcpRuntimeMapAtom = Atom.make((get): Readonly<Record<string, McpRuntimeSnapshot>> => {
  const event = get(mcpRuntimeEventAtom);
  if (event === null) {
    return EMPTY_RUNTIME_MAP;
  }
  const map: Record<string, McpRuntimeSnapshot> = {};
  for (const runtime of event.runtimes) {
    map[mcpRuntimeKey(runtime.projectId, runtime.serverId)] = runtime;
  }
  return map;
}).pipe(Atom.withLabel("ru-code:mcp:runtime-map"));

export const mcpCatalogRuntimeMapAtom = Atom.make(
  (get): Readonly<Record<string, McpCatalogRuntimeSnapshot>> => {
    const event = get(mcpRuntimeEventAtom);
    if (event === null) {
      return EMPTY_CATALOG_RUNTIME_MAP;
    }
    const map: Record<string, McpCatalogRuntimeSnapshot> = {};
    for (const runtime of event.catalogRuntimes) {
      map[runtime.serverId] = runtime;
    }
    return map;
  },
).pipe(Atom.withLabel("ru-code:mcp:catalog-runtime-map"));

/** Imperative reads at mutation time (panel is open ⇒ the subscriptions are live). */
export function getMcpBindings(): ReadonlyArray<McpBinding> {
  return appAtomRegistry.get(mcpBindingsAtom);
}

export function getMcpRuntimeMap(): Readonly<Record<string, McpRuntimeSnapshot>> {
  return appAtomRegistry.get(mcpRuntimeMapAtom);
}
