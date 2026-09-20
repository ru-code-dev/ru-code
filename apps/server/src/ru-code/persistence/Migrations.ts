// ru-code: fork-owned migration runner — a SEPARATE id space in a SEPARATE bookkeeping table
// (`ru_code_migrations`) from upstream's `effect_sql_migrations`. The effect Migrator only runs
// ids GREATER than the latest recorded id per table, so sharing upstream's table would either
// force renumbering our entries on every upstream sync or silently skip new upstream migrations
// once a higher fork id was recorded. With two tables, upstream numbering (33, 34, …) and fork
// numbering (1, 2, …) never meet. Invoked from the one seam in persistence/Layers/Sqlite.ts,
// right after the upstream migrations — the same place both the live DB and every in-memory
// test graph run theirs.
//
// Append-only: new fork migrations take the next id. NEVER renumber a shipped entry.

import { mcpMigration } from "@smart-tools/qwen-cli-mcp-manager/server";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import projectionThreadsChatViewMode from "./Migrations/002_ProjectionThreadsChatViewMode.ts";
import projectionThreadMessagesDeliveryState from "./Migrations/004_ProjectionThreadMessagesDeliveryState.ts";

const RU_CODE_MIGRATIONS_TABLE = "ru_code_migrations";

export const ruCodeMigrationEntries = [
  // MCP manager tables (DDL lives with the feature package).
  [1, "Mcp", mcpMigration],
  // Per-thread chat-view choice column (extended-chat feature).
  [2, "ProjectionThreadsChatViewMode", projectionThreadsChatViewMode],
  // ru-code (A19): id 3 was "QwenUsage" — the analytics transcript cache. Analytics is now a
  // dropped-in plugin that owns its own `analytics_file_cache` in its own `data.sqlite`, so the
  // app no longer registers that migration. The entry is REMOVED rather than parked: the effect
  // Migrator only compares each loaded id against the MAX recorded id (Migrator.js `run`: skip
  // when `currentId <= latestMigrationId`) and only rejects DUPLICATE ids — it has no
  // contiguity/id-space check, so a gap is a no-op on both paths. Existing installs recorded
  // 1..4 and run nothing; fresh installs record 1, 2, 4. The already-created
  // `analytics_file_cache` table is deliberately LEFT IN PLACE on existing installs (dropping
  // user data is a separate owner decision — phase-2 plan §4.2 / O4). **Id 3 is burned: never
  // reuse it.** Append-only still holds — the next fork migration takes id 5.
  // Mid-turn delivery mark column (pending | delivered | not-delivered).
  [4, "ProjectionThreadMessagesDeliveryState", projectionThreadMessagesDeliveryState],
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(
    ruCodeMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

/** Run all pending fork migrations (tracked in `ru_code_migrations`). */
export const runRuCodeMigrations = Effect.fn("runRuCodeMigrations")(function* () {
  const executedMigrations = yield* run({ loader, table: RU_CODE_MIGRATIONS_TABLE });
  yield* Effect.logDebug("ru-code migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});
