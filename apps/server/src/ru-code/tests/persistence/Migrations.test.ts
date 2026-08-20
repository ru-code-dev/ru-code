// ru-code: pins the fork-owned migration runner's contract (ru-code/persistence/Migrations.ts):
// fork migrations are tracked in their OWN `ru_code_migrations` table with their OWN id space, so
// upstream renumbering during a resync can neither collide with fork ids nor be skipped because a
// higher fork id was recorded in the shared table (the effect Migrator only runs ids greater than
// the latest recorded id per table). Also pins idempotency — the Sqlite `setup` layer runs this on
// every boot, so a re-run over an already-migrated database must be a no-op.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { runRuCodeMigrations } from "../../persistence/Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const listTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

layer("ru-code fork migrations", (it) => {
  it.effect("creates the MCP tables and records them in ru_code_migrations, not upstream's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const executed = yield* runRuCodeMigrations();
      assert.deepStrictEqual(
        executed.map(([id, name]) => `${id}_${name}`),
        ["1_Mcp"],
      );

      const tables = yield* listTables;
      assert.include(tables, "mcp_catalog_server");
      assert.include(tables, "mcp_project_binding");
      assert.include(tables, "mcp_probe_cache");

      const recorded = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM ru_code_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => `${row.migration_id}_${row.name}`),
        ["1_Mcp"],
      );

      // The fork run must NOT touch upstream's bookkeeping table.
      assert.notInclude(tables, "effect_sql_migrations");
    }),
  );

  it.effect("is idempotent — a second run executes nothing", () =>
    Effect.gen(function* () {
      yield* runRuCodeMigrations();
      const secondRun = yield* runRuCodeMigrations();
      assert.deepStrictEqual(secondRun, []);
    }),
  );
});

// A separate layer block = a separate in-memory database (the block above shares one DB
// across its tests, and this scenario needs a pristine one).
const coexistenceLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

coexistenceLayer("ru-code fork migrations — coexistence with upstream", (it) => {
  it.effect("fork ids are independent of upstream's — both runners coexist on one database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Upstream migrations record 1..N in effect_sql_migrations; the fork records its own 1..M
      // in ru_code_migrations. Identical low ids on one database prove the id spaces are disjoint.
      yield* runMigrations();
      const executed = yield* runRuCodeMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [1],
      );

      const upstreamFirst = yield* sql<{ migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 1
      `;
      const forkFirst = yield* sql<{ migration_id: number }>`
        SELECT migration_id FROM ru_code_migrations WHERE migration_id = 1
      `;
      assert.lengthOf(upstreamFirst, 1);
      assert.lengthOf(forkFirst, 1);
    }),
  );
});
