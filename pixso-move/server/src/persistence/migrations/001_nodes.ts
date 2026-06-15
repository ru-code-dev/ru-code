import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// `nodes` — immutable ingestion records. Append-only; never mutated.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL,
      root_name TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      preview TEXT NOT NULL,
      added_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_nodes_designer ON nodes(designer_id, added_at)`;
});
