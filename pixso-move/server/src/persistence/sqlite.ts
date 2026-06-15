import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as NodeSqliteClient from "../vendor/NodeSqliteClient.ts";
import { runMigrations } from "./migrate.ts";

// PRAGMA + migrations, applied on top of the raw SqlClient layer.
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations;
  }),
);

// In-memory persistence (tests).
export const SqlitePersistenceMemory = Layer.provideMerge(setup, NodeSqliteClient.layerMemory());

// File-backed persistence (production); creates the parent dir.
export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  return Layer.provideMerge(setup, NodeSqliteClient.layer({ filename: dbPath }));
}, Layer.unwrap);

// Production persistence resolved from ServerConfig.dbPath.
export const persistenceLive = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), (config) => makeSqlitePersistenceLive(config.dbPath)),
);
