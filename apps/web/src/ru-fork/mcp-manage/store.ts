/**
 * MCP Manager — UI state + demo data store (zustand).
 *
 * Holds both the panel/selection UI state and the in-memory catalog/bindings seeded from
 * {@link fakeData}. Mutations are local-only (no persistence, no network) — enough to make
 * the demo feel real: adding a server, binding it to a project, toggling tools, etc.
 */

import { create } from "zustand";
import {
  FAKE_BINDINGS,
  FAKE_PROJECTS,
  FAKE_REGISTRY,
} from "./fakeData";
import type {
  McpPanelTab,
  McpProject,
  McpProjectBinding,
  McpRegistryServer,
  McpServerConfig,
} from "./types";

interface AddServerInput {
  readonly name: string;
  readonly description: string;
  readonly config: McpServerConfig;
}

interface McpManagerState {
  // ── persisted-ish demo data ──────────────────────────────────────────────
  readonly registry: readonly McpRegistryServer[];
  readonly projects: readonly McpProject[];
  readonly bindings: readonly McpProjectBinding[];

  // ── panel / selection UI state ───────────────────────────────────────────
  readonly panelOpen: boolean;
  readonly activeTab: McpPanelTab;
  readonly selectedServerId: string | null;
  readonly selectedProjectId: string;

  // ── panel actions ────────────────────────────────────────────────────────
  readonly setPanelOpen: (open: boolean) => void;
  readonly togglePanel: () => void;
  readonly setActiveTab: (tab: McpPanelTab) => void;
  readonly selectServer: (serverId: string | null) => void;
  readonly selectProject: (projectId: string) => void;

  // ── data actions ─────────────────────────────────────────────────────────
  /** Add a new custom server to the catalog and select it. Returns the new id. */
  readonly addServer: (input: AddServerInput) => string;
  /** Update an existing catalog server's name/description/config. */
  readonly updateServer: (serverId: string, input: AddServerInput) => void;
  /**
   * Set (or clear, with `null`) a project-specific config override for a binding.
   * Clearing reverts the binding to the catalog default.
   */
  readonly setBindingConfig: (
    serverId: string,
    projectId: string,
    config: McpServerConfig | null,
  ) => void;
  /** Bind a catalog server to a project (no-op if already bound). */
  readonly addBindingToProject: (serverId: string, projectId: string) => void;
  /** Remove a server from a project. */
  readonly removeBinding: (serverId: string, projectId: string) => void;
  /** Master enable/disable of a server within a project. */
  readonly setBindingEnabled: (serverId: string, projectId: string, enabled: boolean) => void;
  /** Toggle a single tool for a project binding (override). */
  readonly setToolEnabled: (
    serverId: string,
    projectId: string,
    toolName: string,
    enabled: boolean,
  ) => void;
}

let nextServerSeq = 1;

function makeServerId(): string {
  return `srv-custom-${nextServerSeq++}`;
}

export const useMcpManagerStore = create<McpManagerState>()((set, get) => ({
  registry: FAKE_REGISTRY,
  projects: FAKE_PROJECTS,
  bindings: FAKE_BINDINGS,

  panelOpen: false,
  activeTab: "registry",
  selectedServerId: FAKE_REGISTRY[0]?.id ?? null,
  selectedProjectId: FAKE_PROJECTS[0]?.id ?? "",

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  setActiveTab: (tab) => set({ activeTab: tab }),
  selectServer: (serverId) => set({ selectedServerId: serverId }),
  selectProject: (projectId) => set({ selectedProjectId: projectId }),

  addServer: (input) => {
    const id = makeServerId();
    const server: McpRegistryServer = {
      id,
      name: input.name,
      description: input.description,
      source: "custom",
      config: input.config,
      tools: [],
      tags: [input.config.transport],
    };
    set((state) => ({
      registry: [...state.registry, server],
      selectedServerId: id,
      activeTab: "registry",
    }));
    return id;
  },

  updateServer: (serverId, input) =>
    set((state) => ({
      registry: state.registry.map((server) =>
        server.id === serverId
          ? {
              ...server,
              name: input.name,
              description: input.description,
              config: input.config,
            }
          : server,
      ),
    })),

  setBindingConfig: (serverId, projectId, config) =>
    set((state) => ({
      bindings: state.bindings.map((binding) => {
        if (!(binding.serverId === serverId && binding.projectId === projectId)) {
          return binding;
        }
        if (config === null) {
          const { configOverride: _dropped, ...rest } = binding;
          return rest;
        }
        return { ...binding, configOverride: config };
      }),
    })),

  addBindingToProject: (serverId, projectId) => {
    const exists = get().bindings.some(
      (binding) => binding.serverId === serverId && binding.projectId === projectId,
    );
    if (exists) return;
    const binding: McpProjectBinding = {
      projectId,
      serverId,
      enabled: true,
      status: "connecting",
      health: { detail: "Подключение…" },
      toolOverrides: {},
    };
    set((state) => ({ bindings: [...state.bindings, binding] }));
  },

  removeBinding: (serverId, projectId) =>
    set((state) => ({
      bindings: state.bindings.filter(
        (binding) => !(binding.serverId === serverId && binding.projectId === projectId),
      ),
    })),

  setBindingEnabled: (serverId, projectId, enabled) =>
    set((state) => ({
      bindings: state.bindings.map((binding) =>
        binding.serverId === serverId && binding.projectId === projectId
          ? {
              ...binding,
              enabled,
              status: enabled ? "connecting" : "disabled",
              health: enabled
                ? { detail: "Подключение…" }
                : { detail: "Отключён в этом проекте" },
            }
          : binding,
      ),
    })),

  setToolEnabled: (serverId, projectId, toolName, enabled) =>
    set((state) => ({
      bindings: state.bindings.map((binding) =>
        binding.serverId === serverId && binding.projectId === projectId
          ? { ...binding, toolOverrides: { ...binding.toolOverrides, [toolName]: enabled } }
          : binding,
      ),
    })),
}));

// ── derived selectors (pure helpers) ────────────────────────────────────────

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

/** The config a binding actually runs with: its per-project override, or the catalog default. */
export function effectiveBindingConfig(
  binding: McpProjectBinding,
  server: McpRegistryServer,
): McpServerConfig {
  return binding.configOverride ?? server.config;
}
