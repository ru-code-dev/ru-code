import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// ru-fork: the SINGLE migration for the Stats feature (unreleased — edit THIS file
// rather than stacking 033+). One row per scanned chat file, keyed by absolute
// file_path. mtime_ms + size_bytes are the change-detector (re-parse only on a
// mismatch). session_json holds the computed StatsSession. present = 0 means the
// source file is gone but its stats are retained (kept, never deleted).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS stats_file_cache (
      file_path     TEXT PRIMARY KEY,
      mtime_ms      INTEGER NOT NULL,
      size_bytes    INTEGER NOT NULL,
      present       INTEGER NOT NULL DEFAULT 1,
      last_seen_at  TEXT NOT NULL,
      session_json  TEXT NOT NULL
    )
  `;
});
