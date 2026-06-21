import { McpCatalogServer, McpServerId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const RemoveCatalogServerInput = Schema.Struct({ serverId: McpServerId });
export type RemoveCatalogServerInput = typeof RemoveCatalogServerInput.Type;

/** Persistence for the global MCP catalog (one row per server definition). */
export interface McpCatalogRepositoryShape {
  readonly upsert: (server: McpCatalogServer) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<McpCatalogServer>,
    ProjectionRepositoryError
  >;
  readonly remove: (
    input: RemoveCatalogServerInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class McpCatalogRepository extends Context.Service<
  McpCatalogRepository,
  McpCatalogRepositoryShape
>()("@ru-code/ru-code/persistence/Services/McpCatalog/McpCatalogRepository") {}
