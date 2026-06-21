import { StatsSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** One persisted cache row: a computed StatsSession + on-disk identity. */
export const StatsFileCacheRow = Schema.Struct({
  filePath: Schema.String,
  mtimeMs: Schema.Number,
  sizeBytes: Schema.Number,
  present: Schema.Boolean,
  lastSeenAt: Schema.String,
  session: StatsSession,
});
export type StatsFileCacheRow = typeof StatsFileCacheRow.Type;

export const MarkAbsentInput = Schema.Struct({
  filePaths: Schema.Array(Schema.String),
  lastSeenAt: Schema.String,
});
export type MarkAbsentInput = typeof MarkAbsentInput.Type;

/**
 * Persistence for the per-file stats cache (one row per chat file, keyed by
 * absolute file_path). Reads/writes the computed StatsSession; never the raw
 * transcript content.
 */
export interface StatsFileCacheRepositoryShape {
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<StatsFileCacheRow>,
    ProjectionRepositoryError
  >;
  readonly upsert: (row: StatsFileCacheRow) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Flip present→0 (+ lastSeenAt) for files no longer on disk. Rows are kept. */
  readonly markAbsent: (input: MarkAbsentInput) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Hard-delete rows by path (zero-usage "ghost" files that aren't real sessions). */
  readonly removeByPaths: (filePaths: ReadonlyArray<string>) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class StatsFileCacheRepository extends Context.Service<
  StatsFileCacheRepository,
  StatsFileCacheRepositoryShape
>()("@ru-code/ru-code/persistence/Services/StatsFileCache/StatsFileCacheRepository") {}
