import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

const makeRuntimeSqliteLayer = (config: RuntimeSqliteLayerConfig) => NodeSqliteClient.layer(config);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // ru-fork: CITRIX/VDI FIX (Option A — "WAL without shared memory").
    // UNCOMMENT the line below ONLY after the round-1 log (ws.ts "shell-stream:
    // failed to build project shell") confirms SQLITE_IOERR/CANTOPEN on -shm —
    // i.e. WAL's shared-memory file can't be backed (network/FSLogix profile).
    // Setting EXCLUSIVE locking BEFORE `journal_mode = WAL` keeps the wal-index
    // in heap and creates NO -shm file, so WAL works on those filesystems.
    // It MUST stay above the WAL line below.
    // CAVEAT: exclusive lock = single process only. `cli project` / `cli auth`
    // run against a RUNNING server will fail to open the DB (they mint an auth
    // token via their own connection). GUI usage is unaffected. If you need the
    // CLI against a live server, use Option B instead: replace the WAL line with
    // `PRAGMA journal_mode = TRUNCATE;` (no -shm, allows concurrent openers,
    // slightly slower writes; keep synchronous at the default FULL).
    // yield* sql`PRAGMA locking_mode = EXCLUSIVE;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // ru-fork: TRANSIENT-LOCK FIX (busy_timeout).
    // UNCOMMENT instead of Option A if the round-1 log shows SQLITE_BUSY/LOCKED
    // (a transient lock — corporate AV / Search indexer / backup holding the
    // -wal/-shm files), NOT SQLITE_IOERR. node:sqlite defaults busy_timeout to
    // 0 (fails instantly on any lock); this waits up to N ms for the lock to
    // clear first. It is a CEILING — zero cost when uncontended. Tune N to
    // exceed the lock window on the slowest target box; the cost is an up-to-N
    // ms event-loop stall during a real long lock (node:sqlite is synchronous).
    // yield* sql`PRAGMA busy_timeout = 3000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
