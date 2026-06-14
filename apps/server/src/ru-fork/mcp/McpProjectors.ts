// ru-fork: MCP SQL projector bodies, kept out of the shared ProjectionPipeline.
// Factories over the repos return the `apply(event)` the pipeline registers.

import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { McpBindingRepositoryShape } from "../../persistence/Services/McpBinding.ts";
import type { McpCatalogRepositoryShape } from "../../persistence/Services/McpCatalog.ts";

type McpProjector = (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;

/** Catalog rows + cascade-remove a server's bindings when the server is removed. */
export function makeMcpCatalogProjector(
  catalogRepository: McpCatalogRepositoryShape,
  bindingRepository: McpBindingRepositoryShape,
): McpProjector {
  return Effect.fn("applyMcpCatalogProjection")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "mcp.server-added":
      case "mcp.server-updated":
        yield* catalogRepository.upsert(event.payload.server);
        return;
      case "mcp.server-removed":
        yield* catalogRepository.remove({ serverId: event.payload.serverId });
        yield* bindingRepository.removeByServer({ serverId: event.payload.serverId });
        return;
      default:
        return;
    }
  });
}

/** Binding rows + cascade-remove a project's bindings on project.deleted. */
export function makeMcpBindingProjector(
  bindingRepository: McpBindingRepositoryShape,
): McpProjector {
  return Effect.fn("applyMcpBindingProjection")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "mcp.binding-set":
        yield* bindingRepository.upsert(event.payload.binding);
        return;
      case "mcp.binding-removed":
        yield* bindingRepository.remove({
          projectId: event.payload.projectId,
          serverId: event.payload.serverId,
        });
        return;
      case "project.deleted":
        yield* bindingRepository.removeByProject({ projectId: event.payload.projectId });
        return;
      default:
        return;
    }
  });
}
