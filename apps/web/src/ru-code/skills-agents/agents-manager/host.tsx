// ru-code: the Agents panel host. Mirror of the Skills host — adapts port's runtime to the
// package's ItemManagerWebPorts and renders the shared AgentsPanel inside its provider.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import {
  AgentManagerProvider,
  AgentsPanel,
  type AgentManagerWebPorts,
} from "@smart-tools/qwen-cli-agents-manager/web";
import { useMemo } from "react";

import { useCatalogClient } from "../catalog/useCatalogClient";
import {
  toastError,
  useActiveProjectId,
  useProjectsSource,
  useResolvedTheme,
} from "../catalog/hostPorts";

export function AgentsPanelHost({
  onClose,
  mode,
}: {
  readonly onClose: () => void;
  readonly mode: DiffPanelMode;
}) {
  const client = useCatalogClient("agentCatalog");
  const ports = useMemo<AgentManagerWebPorts>(
    () => ({ client, toastError, useResolvedTheme, useActiveProjectId, useProjectsSource }),
    [client],
  );
  return (
    <AgentManagerProvider ports={ports}>
      <AgentsPanel onClose={onClose} mode={mode} />
    </AgentManagerProvider>
  );
}
