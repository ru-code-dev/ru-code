// ru-code: the Skills panel host. Adapts port's runtime (RPC client + host hooks) to the
// package's ItemManagerWebPorts, then renders the shared SkillsPanel inside its provider.

import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";
import {
  SkillManagerProvider,
  SkillsPanel,
  type SkillManagerWebPorts,
} from "@smart-tools/qwen-cli-skill-manager/web";
import { useMemo } from "react";

import { useCatalogClient } from "../catalog/useCatalogClient";
import {
  toastError,
  useActiveProjectId,
  useProjectsSource,
  useResolvedTheme,
} from "../catalog/hostPorts";

export function SkillsPanelHost({
  onClose,
  mode,
}: {
  readonly onClose: () => void;
  readonly mode: DiffPanelMode;
}) {
  const client = useCatalogClient("skillCatalog");
  const ports = useMemo<SkillManagerWebPorts>(
    () => ({ client, toastError, useResolvedTheme, useActiveProjectId, useProjectsSource }),
    [client],
  );
  return (
    <SkillManagerProvider ports={ports}>
      <SkillsPanel onClose={onClose} mode={mode} />
    </SkillManagerProvider>
  );
}
