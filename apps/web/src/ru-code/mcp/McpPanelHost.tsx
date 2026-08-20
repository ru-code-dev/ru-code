// ru-code: the MCP panel host. Adapts port's runtime (subscription atoms + RPC commands +
// host hooks) to the package's McpManagerWebPorts, then renders the shared McpPanel inside
// its provider — the same shape as the skills/agents panel hosts.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import {
  McpServerId,
  ProjectId,
  type McpClientCommand,
} from "@smart-tools/qwen-cli-mcp-manager/contracts";
import {
  McpManagerProvider,
  McpPanel,
  type McpManagerWebPorts,
} from "@smart-tools/qwen-cli-mcp-manager/web";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { readLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";

import {
  toastError,
  useActiveProjectId,
  useProjectsSource,
} from "../skills-agents/catalog/hostPorts";
import { dispatchMcpCommand, mcpRecheck } from "./mcpActions";
import {
  getMcpBindings,
  getMcpRuntimeMap,
  mcpBindingsAtom,
  mcpCatalogAtom,
  mcpCatalogRuntimeMapAtom,
  mcpRuntimeMapAtom,
} from "./mcpState";

function useMcpCatalog() {
  return useAtomValue(mcpCatalogAtom);
}
function useMcpBindings() {
  return useAtomValue(mcpBindingsAtom);
}
function useMcpRuntimeMap() {
  return useAtomValue(mcpRuntimeMapAtom);
}
function useMcpCatalogRuntimeMap() {
  return useAtomValue(mcpCatalogRuntimeMapAtom);
}

export function McpPanelHost({
  onClose,
  mode,
}: {
  readonly onClose: () => void;
  readonly mode: DiffPanelMode;
}) {
  const environmentId = usePrimaryEnvironmentId();

  const ports = useMemo<McpManagerWebPorts>(() => {
    const noConnection = () => Promise.reject(new Error("Нет активного подключения к серверу."));
    return {
      useCatalog: useMcpCatalog,
      useBindings: useMcpBindings,
      useRuntimeMap: useMcpRuntimeMap,
      useCatalogRuntimeMap: useMcpCatalogRuntimeMap,
      getBindings: getMcpBindings,
      getRuntimeMap: getMcpRuntimeMap,
      useProjects: useProjectsSource,
      useActiveProjectId,
      dispatchCommand: (command: McpClientCommand) =>
        environmentId === null ? noConnection() : dispatchMcpCommand(environmentId, command),
      recheck: (filter) =>
        environmentId === null
          ? noConnection()
          : mcpRecheck(environmentId, {
              ...(filter.projectId !== undefined
                ? { projectId: ProjectId.make(filter.projectId) }
                : {}),
              ...(filter.serverId !== undefined
                ? { serverId: McpServerId.make(filter.serverId) }
                : {}),
              ...(filter.transport !== undefined ? { transport: filter.transport } : {}),
            }),
      toastError,
      showContextMenu: (items, position) => {
        const api = readLocalApi();
        if (!api) {
          return null;
        }
        return api.contextMenu.show(
          items.map((item) => ({
            id: item.id,
            label: item.label,
            ...(item.destructive !== undefined ? { destructive: item.destructive } : {}),
            ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
          })),
          position,
        );
      },
    };
  }, [environmentId]);

  return (
    <McpManagerProvider ports={ports}>
      <McpPanel onClose={onClose} mode={mode} />
    </McpManagerProvider>
  );
}
