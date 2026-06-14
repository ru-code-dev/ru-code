/**
 * MCP Manager — panel/selection UI state (zustand).
 *
 * ru-fork: the catalog/bindings/projects data + mutations used to live here on
 * fake in-memory state. They now come from the real backend via {@link useMcp}
 * (atoms in rpc/mcpState + the 5 mcp.* orchestration commands). This store holds
 * ONLY ephemeral UI state — which panel/tab/selection is open. The pure
 * selectors below operate on the UI view-types the hooks produce.
 */

import { create } from "zustand";
import type { McpPanelTab, McpProjectBinding, McpRegistryServer } from "./types";

interface McpManagerState {
  readonly panelOpen: boolean;
  readonly activeTab: McpPanelTab;
  readonly selectedServerId: string | null;
  readonly selectedProjectId: string;

  readonly setPanelOpen: (open: boolean) => void;
  readonly togglePanel: () => void;
  readonly setActiveTab: (tab: McpPanelTab) => void;
  readonly selectServer: (serverId: string | null) => void;
  readonly selectProject: (projectId: string) => void;
}

export const useMcpManagerStore = create<McpManagerState>()((set) => ({
  panelOpen: false,
  activeTab: "registry",
  selectedServerId: null,
  selectedProjectId: "",

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  setActiveTab: (tab) => set({ activeTab: tab }),
  selectServer: (serverId) => set({ selectedServerId: serverId }),
  selectProject: (projectId) => set({ selectedProjectId: projectId }),
}));

// ── derived selectors (pure helpers over the UI view-types) ──────────────────

export function selectServerById(
  registry: readonly McpRegistryServer[],
  serverId: string | null,
): McpRegistryServer | null {
  if (serverId === null) return null;
  return registry.find((server) => server.id === serverId) ?? null;
}

export function selectProjectBindings(
  bindings: readonly McpProjectBinding[],
  projectId: string,
): readonly McpProjectBinding[] {
  return bindings.filter((binding) => binding.projectId === projectId);
}

/** Project ids a given server is currently bound to. */
export function selectProjectsForServer(
  bindings: readonly McpProjectBinding[],
  serverId: string,
): readonly string[] {
  return bindings
    .filter((binding) => binding.serverId === serverId)
    .map((binding) => binding.projectId);
}

/** A tool is enabled unless explicitly overridden to false. */
export function isToolEnabled(binding: McpProjectBinding, toolName: string): boolean {
  return binding.toolOverrides[toolName] !== false;
}
