// ru-code: the MCP manager's action half — promise wrappers over the environment-scoped
// RPC commands, exactly like the catalog client (see useCatalogClient): each call runs
// against the PRIMARY environment and unwraps the settled AsyncResult into resolve/reject
// (the reject carries the server's readable failure message — the panel strips the
// invariant prefix before display).

import type {
  McpClientCommand,
  McpServerId,
  McpTransport,
  ProjectId,
} from "@smart-tools/qwen-cli-mcp-manager/contracts";
import { ORCHESTRATION_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

// Run one unary RPC against an environment and unwrap the settled result: resolve with
// the success value, reject with the squashed failure cause.
async function runMcpRpc<TTag extends EnvironmentUnaryRpcTag>(
  tag: TTag,
  label: string,
  environmentId: EnvironmentId,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const command = createEnvironmentRpcCommand(connectionAtomRuntime, { label, tag });
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

/** Dispatch one MCP orchestration command (mutations ride the shared dispatch RPC). */
export function dispatchMcpCommand(
  environmentId: EnvironmentId,
  command: McpClientCommand,
): Promise<void> {
  return runMcpRpc(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    "mcp:dispatchCommand",
    environmentId,
    command,
  ).then(() => undefined);
}

/** Force a probe NOW of the matching live instances (manual "Проверить" / refresh). */
export function mcpRecheck(
  environmentId: EnvironmentId,
  filter: {
    readonly projectId?: ProjectId;
    readonly serverId?: McpServerId;
    readonly transport?: McpTransport;
  },
): Promise<void> {
  return runMcpRpc("mcp.recheck", "mcp:recheck", environmentId, filter).then(() => undefined);
}

/** Tell the server which project the client is viewing (scopes auto-probing). */
export function mcpSetActiveProject(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): Promise<void> {
  return runMcpRpc("mcp.setActiveProject", "mcp:setActiveProject", environmentId, {
    projectId,
  }).then(() => undefined);
}
