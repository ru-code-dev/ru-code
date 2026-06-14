// ru-fork: client-side MCP read state. Mirrors serverState.ts — atoms fed by the
// `mcp` RPC streams (projection = authored catalog/bindings, runtime = live
// status). Mutations go through orchestration.dispatchCommand, not here.

import { useAtomValue } from "@effect/atom-react";
import type {
  McpBinding,
  McpCatalogRuntimeSnapshot,
  McpCatalogServer,
  McpProjectionStreamEvent,
  McpRuntimeSnapshot,
  McpRuntimeStreamEvent,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { WsRpcClient } from "./wsRpcClient";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "./atomRegistry";

type McpStateClient = Pick<
  WsRpcClient["mcp"],
  "getSnapshot" | "subscribeProjection" | "subscribeRuntime"
>;

/** Stable key for one project↔server runtime row. */
export function mcpRuntimeKey(projectId: string, serverId: string): string {
  return `${projectId}:${serverId}`;
}

function makeStateAtom<A>(label: string, initialValue: A) {
  return Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label));
}

const EMPTY_CATALOG: ReadonlyArray<McpCatalogServer> = [];
const EMPTY_BINDINGS: ReadonlyArray<McpBinding> = [];
const EMPTY_RUNTIME: Readonly<Record<string, McpRuntimeSnapshot>> = {};
const EMPTY_CATALOG_RUNTIME: Readonly<Record<string, McpCatalogRuntimeSnapshot>> = {};

export const mcpCatalogAtom = makeStateAtom<ReadonlyArray<McpCatalogServer>>(
  "mcp-catalog",
  EMPTY_CATALOG,
);
export const mcpBindingsAtom = makeStateAtom<ReadonlyArray<McpBinding>>(
  "mcp-bindings",
  EMPTY_BINDINGS,
);
export const mcpRuntimeAtom = makeStateAtom<Readonly<Record<string, McpRuntimeSnapshot>>>(
  "mcp-runtime",
  EMPTY_RUNTIME,
);
// Catalog-level runtime keyed by serverId (status + tools of the default config).
export const mcpCatalogRuntimeAtom = makeStateAtom<
  Readonly<Record<string, McpCatalogRuntimeSnapshot>>
>("mcp-catalog-runtime", EMPTY_CATALOG_RUNTIME);

export function applyMcpProjectionEvent(event: McpProjectionStreamEvent): void {
  // The server only ever emits a full snapshot — a pure replace of the catalog + bindings atoms.
  appAtomRegistry.set(mcpCatalogAtom, event.snapshot.catalog);
  appAtomRegistry.set(mcpBindingsAtom, event.snapshot.bindings);
}

export function applyMcpRuntimeEvent(event: McpRuntimeStreamEvent): void {
  const runtimeByKey: Record<string, McpRuntimeSnapshot> = {};
  for (const runtime of event.runtimes) {
    runtimeByKey[mcpRuntimeKey(runtime.projectId, runtime.serverId)] = runtime;
  }
  appAtomRegistry.set(mcpRuntimeAtom, runtimeByKey);

  const catalogRuntimeByServerId: Record<string, McpCatalogRuntimeSnapshot> = {};
  for (const catalogRuntime of event.catalogRuntimes) {
    catalogRuntimeByServerId[catalogRuntime.serverId] = catalogRuntime;
  }
  appAtomRegistry.set(mcpCatalogRuntimeAtom, catalogRuntimeByServerId);
}

export function startMcpStateSync(client: McpStateClient): () => void {
  let disposed = false;
  const cleanups = [
    client.subscribeProjection((event) => {
      applyMcpProjectionEvent(event);
    }),
    client.subscribeRuntime((event) => {
      applyMcpRuntimeEvent(event);
    }),
  ];

  // Eager snapshot for the catalog/bindings (runtime arrives via its stream's
  // own initial snapshot). projectId null ⇒ all bindings.
  if (appAtomRegistry.get(mcpCatalogAtom).length === 0) {
    void client
      .getSnapshot({ projectId: null })
      .then((snapshot) => {
        if (disposed) {
          return;
        }
        applyMcpProjectionEvent({ type: "snapshot", snapshot });
      })
      .catch(() => undefined);
  }

  return () => {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

export function useMcpCatalog(): ReadonlyArray<McpCatalogServer> {
  return useAtomValue(mcpCatalogAtom);
}

export function useMcpBindings(): ReadonlyArray<McpBinding> {
  return useAtomValue(mcpBindingsAtom);
}

export function useMcpRuntimeMap(): Readonly<Record<string, McpRuntimeSnapshot>> {
  return useAtomValue(mcpRuntimeAtom);
}

export function useMcpCatalogRuntimeMap(): Readonly<Record<string, McpCatalogRuntimeSnapshot>> {
  return useAtomValue(mcpCatalogRuntimeAtom);
}

export function resetMcpStateForTests(): void {
  resetAppAtomRegistryForTests();
}
