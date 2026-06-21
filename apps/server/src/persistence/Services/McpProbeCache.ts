import { McpProbeRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const GetProbeRecordInput = Schema.Struct({ configKey: Schema.String });
export type GetProbeRecordInput = typeof GetProbeRecordInput.Type;

/**
 * Persistence for the probe-result cache (one row per AUTHORED config, keyed by
 * `configCacheKey`). The single source for MCP server status + discovered tools.
 */
export interface McpProbeCacheRepositoryShape {
  readonly upsert: (record: McpProbeRecord) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByKey: (
    input: GetProbeRecordInput,
  ) => Effect.Effect<Option.Option<McpProbeRecord>, ProjectionRepositoryError>;
  /**
   * GC: delete every cache row whose `config_key` is NOT in `configKeys` (the
   * live authored configs). An empty list clears the whole cache.
   */
  readonly deleteKeysNotIn: (
    configKeys: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class McpProbeCacheRepository extends Context.Service<
  McpProbeCacheRepository,
  McpProbeCacheRepositoryShape
>()("@ru-code/ru-code/persistence/Services/McpProbeCache/McpProbeCacheRepository") {}
