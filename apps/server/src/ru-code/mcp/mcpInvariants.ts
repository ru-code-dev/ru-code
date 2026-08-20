// ru-code: MCP catalog/binding command invariants, kept out of the shared
// orchestration/commandInvariants.ts so upstream re-syncs never conflict. Pure helpers
// live in the package; these stay host-side because they fail with the host invariant
// error type (exact error text preserved).

import type { OrchestrationCommand, OrchestrationReadModel, ProjectId } from "@t3tools/contracts";
import type {
  McpBinding,
  McpCatalogServer,
  McpServerId,
} from "@smart-tools/qwen-cli-mcp-manager/contracts";
import { configIdentity } from "@smart-tools/qwen-cli-mcp-manager/server";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";

export function findCatalogServerById(
  readModel: OrchestrationReadModel,
  serverId: McpServerId,
): McpCatalogServer | undefined {
  return readModel.mcpCatalog.find((server) => server.id === serverId);
}

export function findBinding(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
  serverId: McpServerId,
): McpBinding | undefined {
  return readModel.mcpBindings.find(
    (binding) => binding.projectId === projectId && binding.serverId === serverId,
  );
}

export function requireCatalogServer(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly serverId: McpServerId;
}): Effect.Effect<McpCatalogServer, OrchestrationCommandInvariantError> {
  const server = findCatalogServerById(input.readModel, input.serverId);
  if (server) {
    return Effect.succeed(server);
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `MCP server '${input.serverId}' does not exist for command '${input.command.type}'.`,
    }),
  );
}

export function requireCatalogServerAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly serverId: McpServerId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findCatalogServerById(input.readModel, input.serverId)) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `MCP server '${input.serverId}' already exists and cannot be added twice.`,
    }),
  );
}

/**
 * ru-code: reject a catalog write whose structural config identity already exists on ANOTHER server
 * (custom or built-in). A server's identity is its config, not its name. `excludeServerId` is the
 * server being edited (so a non-config edit never collides with itself).
 */
export function requireCatalogConfigUnique(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly identity: string;
  readonly excludeServerId: McpServerId | null;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const clash = input.readModel.mcpCatalog.find(
    (server) =>
      server.id !== input.excludeServerId &&
      configIdentity(server.config, server.vars, server.extraArgs, server.extraHeaders) ===
        input.identity,
  );
  if (!clash) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail:
        `Сервер с такой конфигурацией уже существует: «${clash.name}». ` +
        `Привяжите его к проекту или измените команду/URL, аргументы или заголовки.`,
    }),
  );
}
