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

import { analyticsMigration } from "@smart-tools/qwen-cli-analytics/server";
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
  // Analytics transcript cache (DDL lives with the feature package). Named "QwenUsage",
  // not "Analytics": upstream already owns an unrelated telemetry/AnalyticsService.ts, and
  // a recorded migration name is append-only once shipped. The migrator keys on ID, so an
  // install that already recorded "3_Analytics" simply never re-runs id 3 — the rename
  // affects what NEW installs record, nothing else.
  [3, "QwenUsage", analyticsMigration],
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
