import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { NonNegativeInt, StatsSession } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  MarkAbsentInput,
  StatsFileCacheRepository,
  StatsFileCacheRow,
  type StatsFileCacheRepositoryShape,
} from "../Services/StatsFileCache.ts";

// `present` is a 0/1 INTEGER column (SQLite has no boolean) → converted to boolean
// by rowToCacheRow, exactly like McpCatalog's locked/enabled/trust. session_json
// decodes into a StatsSession.
const StatsFileCacheDbRow = StatsFileCacheRow.mapFields(
  Struct.assign({
    present: NonNegativeInt,
    session: Schema.fromJsonString(StatsSession),
  }),
);
type StatsFileCacheDbRow = typeof StatsFileCacheDbRow.Type;

function rowToCacheRow(row: StatsFileCacheDbRow): StatsFileCacheRow {
  return { ...row, present: row.present !== 0 };
}

const makeStatsFileCacheRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRows = () =>
    sql`
      SELECT file_path AS "filePath", mtime_ms AS "mtimeMs", size_bytes AS "sizeBytes",
             present, last_seen_at AS "lastSeenAt", session_json AS "session"
      FROM stats_file_cache
      ORDER BY file_path ASC
    `;

  const decodeRow = Schema.decodeUnknownEffect(StatsFileCacheDbRow);

  // Decode each row INDIVIDUALLY: one undecodable session_json — a row written by an
  // older StatsSession shape, or a corrupt blob — is dropped + logged rather than
  // failing the whole read. The cache is rebuildable, so refresh recomputes any dropped
  // file on its next scan. Without this, a single stale row wedges BOTH getSnapshot and
  // refresh (refresh reads the cache before it can overwrite anything).
  const listAll = () =>
    Effect.gen(function* () {
      const rawRows = yield* selectRows();
      const decoded = yield* Effect.forEach(rawRows, (rawRow) =>
        decodeRow(rawRow).pipe(
          Effect.map((row) => Option.some(rowToCacheRow(row))),
          Effect.orElseSucceed(() => Option.none<StatsFileCacheRow>()),
        ),
      );
      const rows = decoded.filter(Option.isSome).map((entry) => entry.value);
      const droppedCount = decoded.length - rows.length;
      if (droppedCount > 0) {
        yield* Effect.logError("[stats] dropped undecodable cache rows (recomputed on next refresh)", {
          dropped: droppedCount,
        });
      }
      return rows;
    }).pipe(Effect.mapError(toPersistenceSqlError("StatsFileCache.listAll")));

  const upsertRow = SqlSchema.void({
    Request: StatsFileCacheRow,
    execute: (row) =>
      sql`
        INSERT INTO stats_file_cache (
          file_path, mtime_ms, size_bytes, present, last_seen_at, session_json
        )
        VALUES (
          ${row.filePath}, ${row.mtimeMs}, ${row.sizeBytes}, ${row.present ? 1 : 0},
          ${row.lastSeenAt}, ${JSON.stringify(row.session)}
        )
        ON CONFLICT (file_path) DO UPDATE SET
          mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes,
          present = excluded.present,
          last_seen_at = excluded.last_seen_at,
          session_json = excluded.session_json
      `,
  });

  const markAbsentRows = SqlSchema.void({
    Request: MarkAbsentInput,
    execute: ({ filePaths, lastSeenAt }) =>
      sql`
        UPDATE stats_file_cache
        SET present = 0, last_seen_at = ${lastSeenAt}
        WHERE file_path IN ${sql.in(filePaths)}
      `,
  });

  return {
    listAll,
    upsert: (row) =>
      upsertRow(row).pipe(Effect.mapError(toPersistenceSqlError("StatsFileCache.upsert"))),
    markAbsent: (input) =>
      (input.filePaths.length === 0
        ? Effect.void
        : markAbsentRows(input)
      ).pipe(Effect.mapError(toPersistenceSqlError("StatsFileCache.markAbsent"))),
    removeByPaths: (filePaths) =>
      (filePaths.length === 0
        ? Effect.void
        : sql`DELETE FROM stats_file_cache WHERE file_path IN ${sql.in(filePaths)}`.pipe(Effect.asVoid)
      ).pipe(Effect.mapError(toPersistenceSqlError("StatsFileCache.removeByPaths"))),
  } satisfies StatsFileCacheRepositoryShape;
});

export const StatsFileCacheRepositoryLive = Layer.effect(
  StatsFileCacheRepository,
  makeStatsFileCacheRepository,
);
