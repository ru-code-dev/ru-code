import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// `processing_results` — the job ledger AND the output. One row per (node × tag).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS processing_results (
      id TEXT PRIMARY KEY,
      designer_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      result_tag TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (node_id, result_tag),
      FOREIGN KEY (node_id) REFERENCES nodes(id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_results_status ON processing_results(status)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_results_designer_node
    ON processing_results(designer_id, node_id)
  `;
});
