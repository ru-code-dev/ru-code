import { McpBinding, McpServerId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const RemoveBindingInput = Schema.Struct({ projectId: ProjectId, serverId: McpServerId });
export type RemoveBindingInput = typeof RemoveBindingInput.Type;

export const BindingsByProjectInput = Schema.Struct({ projectId: ProjectId });
export type BindingsByProjectInput = typeof BindingsByProjectInput.Type;

export const BindingsByServerInput = Schema.Struct({ serverId: McpServerId });
export type BindingsByServerInput = typeof BindingsByServerInput.Type;

/** Persistence for per-project MCP bindings (PK = project_id + server_id). */
export interface McpBindingRepositoryShape {
  readonly upsert: (binding: McpBinding) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly remove: (input: RemoveBindingInput) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByProject: (
    input: BindingsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<McpBinding>, ProjectionRepositoryError>;
  readonly removeByProject: (
    input: BindingsByProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeByServer: (
    input: BindingsByServerInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<McpBinding>, ProjectionRepositoryError>;
}

export class McpBindingRepository extends Context.Service<
  McpBindingRepository,
  McpBindingRepositoryShape
>()("@ru-code/ru-code/persistence/Services/McpBinding/McpBindingRepository") {}
