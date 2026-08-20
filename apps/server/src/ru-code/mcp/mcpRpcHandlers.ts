// ru-code: the ws handlers for the 5 MCP manager RPCs (reads + subscriptions; mutations
// ride orchestration.dispatchCommand). Extracted so ws.ts stays a thin registration seam:
// it yields the package services, builds the observe wrappers (auth + tracing, MCP errors
// encoded into McpError like the catalog handlers), and spreads `buildMcpRpcHandlers(...)`.

import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  MCP_MANAGER_METHODS,
  type McpError,
  type McpServerId,
  type McpTransport,
  type ProjectId,
} from "@smart-tools/qwen-cli-mcp-manager/contracts";
import type {
  McpProjectionQueryShape,
  McpRuntimeShape,
  McpSupervisorShape,
} from "@smart-tools/qwen-cli-mcp-manager/server";

/** Per-method auth scopes: reads + view-scoping use the read scope; a manual recheck
 * spawns real probe processes, so it requires the operate scope. */
export const MCP_RPC_SCOPES = {
  [MCP_MANAGER_METHODS.mcpGetSnapshot]: AuthOrchestrationReadScope,
  [MCP_MANAGER_METHODS.subscribeMcpProjection]: AuthOrchestrationReadScope,
  [MCP_MANAGER_METHODS.subscribeMcpRuntime]: AuthOrchestrationReadScope,
  [MCP_MANAGER_METHODS.mcpSetActiveProject]: AuthOrchestrationReadScope,
  [MCP_MANAGER_METHODS.mcpRecheck]: AuthOrchestrationOperateScope,
} as const;

/** Auth+tracing wrapper for one unary MCP RPC (auth failures encoded into McpError). */
export type ObserveMcpRpc = <A, R>(
  method: string,
  effect: Effect.Effect<A, McpError, R>,
) => Effect.Effect<A, McpError, R>;

/** Auth+tracing wrapper for one MCP subscription stream (same error encoding). */
export type ObserveMcpRpcStream = <A, R>(
  method: string,
  stream: Stream.Stream<A, McpError, R>,
) => Stream.Stream<A, McpError, R>;

export function buildMcpRpcHandlers(deps: {
  readonly mcpProjectionQuery: McpProjectionQueryShape;
  readonly mcpRuntime: McpRuntimeShape;
  readonly mcpSupervisor: McpSupervisorShape;
  readonly observeMcpRpc: ObserveMcpRpc;
  readonly observeMcpRpcStream: ObserveMcpRpcStream;
}) {
  const { mcpProjectionQuery, mcpRuntime, mcpSupervisor, observeMcpRpc, observeMcpRpcStream } =
    deps;
  return {
    [MCP_MANAGER_METHODS.mcpGetSnapshot]: ({
      projectId,
    }: {
      readonly projectId: ProjectId | null;
    }) =>
      observeMcpRpc(MCP_MANAGER_METHODS.mcpGetSnapshot, mcpProjectionQuery.getSnapshot(projectId)),
    [MCP_MANAGER_METHODS.subscribeMcpProjection]: (_input: object) =>
      observeMcpRpcStream(
        MCP_MANAGER_METHODS.subscribeMcpProjection,
        mcpProjectionQuery.subscriptionStream,
      ),
    [MCP_MANAGER_METHODS.subscribeMcpRuntime]: (_input: object) =>
      observeMcpRpcStream(MCP_MANAGER_METHODS.subscribeMcpRuntime, mcpRuntime.subscriptionStream),
    // ru-code: the client signals which project it's viewing; the supervisor scopes
    // auto-probing to it (null ⇒ clear → probe nothing until re-set).
    [MCP_MANAGER_METHODS.mcpSetActiveProject]: ({
      projectId,
    }: {
      readonly projectId: ProjectId | null;
    }) =>
      observeMcpRpc(
        MCP_MANAGER_METHODS.mcpSetActiveProject,
        mcpSupervisor.setWatchedProjects(projectId !== null ? [projectId] : []),
      ),
    // ru-code: manual recheck — force-probe the matching live instances now.
    [MCP_MANAGER_METHODS.mcpRecheck]: (filter: {
      readonly projectId?: ProjectId | undefined;
      readonly serverId?: McpServerId | undefined;
      readonly transport?: McpTransport | undefined;
    }) =>
      observeMcpRpc(
        MCP_MANAGER_METHODS.mcpRecheck,
        mcpSupervisor.recheck({
          ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
          ...(filter.serverId !== undefined ? { serverId: filter.serverId } : {}),
          ...(filter.transport !== undefined ? { transport: filter.transport } : {}),
        }),
      ),
  };
}
