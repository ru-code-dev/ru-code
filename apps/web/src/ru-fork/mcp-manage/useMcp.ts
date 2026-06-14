// ru-fork: the panel's data layer. Reads come from the MCP atoms (rpc/mcpState)
// joined with live runtime + the app's real projects; mutations dispatch the
// 5 mcp.* orchestration commands. Components consume these hooks instead of the
// old fake zustand data store — the UI view-types are produced by ./adapters so
// the components themselves stay unchanged.

import { McpServerId, IsoDateTime, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { newCommandId, randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  mcpBindingsAtom,
  mcpRuntimeAtom,
  mcpRuntimeKey,
  useMcpBindings,
  useMcpCatalog,
  useMcpCatalogRuntimeMap,
  useMcpRuntimeMap,
} from "../../rpc/mcpState";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import {
  bindingToUi,
  catalogServerToRegistry,
  toggleToolPolicy,
  uiConfigToContract,
  uiVarsToDraft,
} from "./adapters";
import type {
  McpProject,
  McpProjectBinding,
  McpRegistryServer,
  McpServerConfig,
  McpVar,
} from "./types";

export interface AddServerInput {
  readonly name: string;
  readonly description: string;
  readonly config: McpServerConfig;
  /** Declared vars (template holes / secrets / per-project params). */
  readonly vars: readonly McpVar[];
  /** User-appendable args (with `${VAR}` holes), appended after the command's own args. */
  readonly extraArgs: readonly string[];
  /** Catalog-level extra/override HTTP headers for a locked http template (B6/⑲). `{}` for manual. */
  readonly extraHeaders: Readonly<Record<string, string>>;
  /** A locked template: the command is read-only, so an update must NOT send a `config` patch. */
  readonly locked?: boolean;
  /** ru-fork #6: «Доверять серверу» — true ⇒ qwen auto-approves this server's tools. */
  readonly trust: boolean;
  /** Default connect/probe timeout in ms (undefined ⇒ 30s default). */
  readonly timeoutMs?: number;
}

/** Per-project edits the project dialog saves: hole values + timeout override. */
export interface ProjectBindingInput {
  /** Per-project var values (plaintext). A name omitted ⇒ inherit the catalog value. */
  readonly varValues: Readonly<Record<string, string>>;
  /** Per-project secret names left untouched (masked, blank) — preserve their stored ref. */
  readonly keepVarValues: readonly string[];
  /** Timeout override in ms; null clears it (inherit the catalog default). */
  readonly timeoutMs: number | null;
}

export function useMcpRegistry(): readonly McpRegistryServer[] {
  const catalog = useMcpCatalog();
  const catalogRuntime = useMcpCatalogRuntimeMap();
  return useMemo(
    () => catalog.map((server) => catalogServerToRegistry(server, catalogRuntime[server.id])),
    [catalog, catalogRuntime],
  );
}

export function useMcpProjects(): readonly McpProject[] {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name, cwd: project.cwd })),
    [projects],
  );
}

export function useMcpProjectBindings(): readonly McpProjectBinding[] {
  const bindings = useMcpBindings();
  const catalog = useMcpCatalog();
  const runtime = useMcpRuntimeMap();
  return useMemo(() => {
    const serverById = new Map(catalog.map((server) => [server.id, server]));
    return bindings.map((binding) =>
      bindingToUi(
        binding,
        serverById.get(binding.serverId),
        runtime[mcpRuntimeKey(binding.projectId, binding.serverId)],
      ),
    );
  }, [bindings, catalog, runtime]);
}

// ── mutations (read current state imperatively, dispatch a command) ───────────

// ru-fork #5: strip the internal "Orchestration command invariant failed (type): " wrapper so the UI
// shows ONLY the human-readable detail (the full error is still logged server-side — see the decider).
function readableMcpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(/^Orchestration command invariant failed \([^)]*\):\s*/u, "").trim();
  return stripped.length > 0 ? stripped : raw;
}

// ru-fork #5: fire-and-forget row actions — a failure becomes a readable UI toast (never a silent no-op).
function dispatchMcpCommandToast(
  command: Parameters<
    ReturnType<typeof getPrimaryEnvironmentConnection>["client"]["orchestration"]["dispatchCommand"]
  >[0],
  failureTitle: string,
): void {
  void getPrimaryEnvironmentConnection()
    .client.orchestration.dispatchCommand(command)
    .catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({ type: "error", title: failureTitle, description: readableMcpError(error) }),
      ),
    );
}

// ru-fork #5: blocking mutations (add/edit/save) — show the readable error as a TOAST and reject so the
// dialog stays OPEN (action blocked); it closes only on success. No technical text reaches the UI.
function dispatchMcpCommandBlocking(
  command: Parameters<
    ReturnType<typeof getPrimaryEnvironmentConnection>["client"]["orchestration"]["dispatchCommand"]
  >[0],
  failureTitle: string,
): Promise<void> {
  return getPrimaryEnvironmentConnection()
    .client.orchestration.dispatchCommand(command)
    .then(() => undefined)
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({ type: "error", title: failureTitle, description: readableMcpError(error) }),
      );
      throw error;
    });
}

function nowIso(): IsoDateTime {
  return IsoDateTime.make(new Date().toISOString());
}

function currentBinding(projectId: string, serverId: string) {
  return appAtomRegistry
    .get(mcpBindingsAtom)
    .find((binding) => binding.projectId === projectId && binding.serverId === serverId);
}

function trimmedDescription(description: string): string | undefined {
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface McpMutations {
  // ru-fork #5: modal mutations return a Promise that REJECTS on a server error so the dialog can
  // render it in its error block; the dialog closes only on success.
  readonly addServer: (input: AddServerInput) => Promise<string>;
  readonly updateServer: (serverId: string, input: AddServerInput) => Promise<void>;
  /** Delete a catalog server (custom only; cascades bindings + secrets + overlays). */
  readonly removeServer: (serverId: string) => void;
  /** Catalog-level on/off toggle (⑬) — disabled servers stop probing + leave every overlay. */
  readonly setServerEnabled: (serverId: string, enabled: boolean) => void;
  /** Save a project's per-project hole values + timeout override (full replace). */
  readonly setProjectBinding: (
    serverId: string,
    projectId: string,
    input: ProjectBindingInput,
  ) => Promise<void>;
  readonly addBindingToProject: (serverId: string, projectId: string) => void;
  readonly removeBinding: (serverId: string, projectId: string) => void;
  readonly setBindingEnabled: (serverId: string, projectId: string, enabled: boolean) => void;
  readonly setToolEnabled: (
    serverId: string,
    projectId: string,
    toolName: string,
    enabled: boolean,
  ) => void;
  /**
   * Force a probe NOW of the matching live instances (manual "Проверить" /
   * refresh). All filters optional + AND-combined; resolves when the probes
   * settle (status/tools then arrive over the runtime stream).
   */
  readonly recheck: (filter: {
    readonly projectId?: string;
    readonly serverId?: string;
    readonly transport?: "stdio" | "http";
  }) => Promise<void>;
}

const mcpMutations: McpMutations = {
  addServer: (input) => {
    const serverId = `srv-${randomUUID()}`;
    const description = trimmedDescription(input.description);
    return dispatchMcpCommandBlocking(
      {
        type: "mcp.server-add",
        commandId: newCommandId(),
        serverId: McpServerId.make(serverId),
        draft: {
          name: input.name,
          ...(description !== undefined ? { description } : {}),
          config: uiConfigToContract(input.config),
          vars: uiVarsToDraft(input.vars),
          extraArgs: [...input.extraArgs],
          extraHeaders: { ...input.extraHeaders },
          trust: input.trust,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        createdAt: nowIso(),
      },
      "Не удалось добавить сервер",
    ).then(() => serverId);
  },

  updateServer: (serverId, input) =>
    dispatchMcpCommandBlocking(
      {
        type: "mcp.server-update",
        commandId: newCommandId(),
        serverId: McpServerId.make(serverId),
        patch: {
          name: input.name,
          description: trimmedDescription(input.description) ?? null,
          // A locked template's command is read-only — omit `config` (the decider rejects it anyway).
          ...(input.locked ? {} : { config: uiConfigToContract(input.config) }),
          vars: uiVarsToDraft(input.vars),
          extraArgs: [...input.extraArgs],
          extraHeaders: { ...input.extraHeaders },
          trust: input.trust,
          timeoutMs: input.timeoutMs ?? null,
        },
      },
      "Не удалось сохранить сервер",
    ),

  removeServer: (serverId) => {
    dispatchMcpCommandToast(
      {
        type: "mcp.server-remove",
        commandId: newCommandId(),
        serverId: McpServerId.make(serverId),
      },
      "Не удалось удалить сервер",
    );
  },

  setServerEnabled: (serverId, enabled) => {
    dispatchMcpCommandToast(
      {
        type: "mcp.server-update",
        commandId: newCommandId(),
        serverId: McpServerId.make(serverId),
        patch: { enabled },
      },
      "Не удалось изменить состояние сервера",
    );
  },

  setProjectBinding: (serverId, projectId, input) =>
    dispatchMcpCommandBlocking(
      {
        type: "mcp.binding-set",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        serverId: McpServerId.make(serverId),
        patch: {
          varValues: { ...input.varValues },
          ...(input.keepVarValues.length > 0 ? { keepVarValues: [...input.keepVarValues] } : {}),
          timeoutMs: input.timeoutMs,
        },
      },
      "Не удалось сохранить настройки",
    ),

  addBindingToProject: (serverId, projectId) => {
    dispatchMcpCommandToast(
      {
        type: "mcp.binding-set",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        serverId: McpServerId.make(serverId),
        patch: { enabled: true },
      },
      "Не удалось добавить сервер в проект",
    );
  },

  removeBinding: (serverId, projectId) => {
    dispatchMcpCommandToast(
      {
        type: "mcp.binding-remove",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        serverId: McpServerId.make(serverId),
      },
      "Не удалось убрать сервер из проекта",
    );
  },

  setBindingEnabled: (serverId, projectId, enabled) => {
    dispatchMcpCommandToast(
      {
        type: "mcp.binding-set",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        serverId: McpServerId.make(serverId),
        patch: { enabled },
      },
      "Не удалось изменить состояние",
    );
  },

  setToolEnabled: (serverId, projectId, toolName, enabled) => {
    const binding = currentBinding(projectId, serverId);
    if (!binding) {
      return;
    }
    const runtime = appAtomRegistry.get(mcpRuntimeAtom)[mcpRuntimeKey(projectId, serverId)];
    dispatchMcpCommandToast(
      {
        type: "mcp.binding-set",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        serverId: McpServerId.make(serverId),
        patch: { toolPolicy: toggleToolPolicy(binding, runtime, toolName, enabled) },
      },
      "Не удалось изменить инструмент",
    );
  },

  recheck: async (filter) => {
    await getPrimaryEnvironmentConnection()
      .client.mcp.recheck({
        ...(filter.projectId !== undefined ? { projectId: ProjectId.make(filter.projectId) } : {}),
        ...(filter.serverId !== undefined ? { serverId: McpServerId.make(filter.serverId) } : {}),
        ...(filter.transport !== undefined ? { transport: filter.transport } : {}),
      })
      .catch((error: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Не удалось проверить сервер",
            description: readableMcpError(error),
          }),
        ),
      );
  },
};

export function useMcpMutations(): McpMutations {
  return mcpMutations;
}
