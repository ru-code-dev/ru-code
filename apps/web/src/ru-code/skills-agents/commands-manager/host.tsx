// ru-code: the Commands panel host. Mirror of the Agents host — adapts port's runtime to the
// package's ItemManagerWebPorts and renders the shared CommandsPanel inside its provider.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import {
  CommandManagerProvider,
  CommandsPanel,
  type CommandManagerWebPorts,
} from "@smart-tools/qwen-cli-commands-manager/web";
import { useMemo } from "react";

import { useCatalogClient } from "../catalog/useCatalogClient";
import {
  toastError,
  useActiveProjectId,
  useProjectsSource,
  useResolvedTheme,
} from "../catalog/hostPorts";

export function CommandsPanelHost({
  onClose,
  mode,
}: {
  readonly onClose: () => void;
  readonly mode: DiffPanelMode;
}) {
  const client = useCatalogClient("commandCatalog");
  const ports = useMemo<CommandManagerWebPorts>(
    () => ({ client, toastError, useResolvedTheme, useActiveProjectId, useProjectsSource }),
    [client],
  );
  return (
    <CommandManagerProvider ports={ports}>
      <CommandsPanel onClose={onClose} mode={mode} />
    </CommandManagerProvider>
  );
}
