import * as Effect from "effect/Effect";

import m001 from "./migrations/001_nodes.ts";
import m002 from "./migrations/002_results.ts";

// Migrations are idempotent DDL (CREATE … IF NOT EXISTS), so we run the ordered
// list every startup — no Migrator registry needed for two tables.
export const runMigrations = Effect.gen(function* () {
  for (const step of [m001, m002]) {
    yield* step;
  }
  yield* Effect.logDebug("migrations applied", { count: 2 });
});
