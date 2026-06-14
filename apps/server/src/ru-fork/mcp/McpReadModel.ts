// ru-fork: pure read-model folds for MCP catalog/bindings, kept out of the
// shared projector.ts so its switch only delegates.

import type { McpBinding, McpCatalogServer, McpServerId, ProjectId } from "@t3tools/contracts";

export function upsertMcpServer(
  catalog: ReadonlyArray<McpCatalogServer>,
  server: McpCatalogServer,
): McpCatalogServer[] {
  const exists = catalog.some((entry) => entry.id === server.id);
  return exists
    ? catalog.map((entry) => (entry.id === server.id ? server : entry))
    : [...catalog, server];
}

export function removeMcpServer(
  catalog: ReadonlyArray<McpCatalogServer>,
  serverId: McpServerId,
): McpCatalogServer[] {
  return catalog.filter((entry) => entry.id !== serverId);
}

function isSameBinding(binding: McpBinding, projectId: ProjectId, serverId: McpServerId): boolean {
  return binding.projectId === projectId && binding.serverId === serverId;
}

export function upsertMcpBinding(
  bindings: ReadonlyArray<McpBinding>,
  binding: McpBinding,
): McpBinding[] {
  const exists = bindings.some((entry) =>
    isSameBinding(entry, binding.projectId, binding.serverId),
  );
  return exists
    ? bindings.map((entry) =>
        isSameBinding(entry, binding.projectId, binding.serverId) ? binding : entry,
      )
    : [...bindings, binding];
}

export function removeMcpBinding(
  bindings: ReadonlyArray<McpBinding>,
  projectId: ProjectId,
  serverId: McpServerId,
): McpBinding[] {
  return bindings.filter((entry) => !isSameBinding(entry, projectId, serverId));
}

export function removeMcpBindingsByProject(
  bindings: ReadonlyArray<McpBinding>,
  projectId: ProjectId,
): McpBinding[] {
  return bindings.filter((entry) => entry.projectId !== projectId);
}

export function removeMcpBindingsByServer(
  bindings: ReadonlyArray<McpBinding>,
  serverId: McpServerId,
): McpBinding[] {
  return bindings.filter((entry) => entry.serverId !== serverId);
}
