import { IsoDateTime, type StatsSession } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { StatsFileCacheRepository } from "../../../src/persistence/Services/StatsFileCache.ts";
import type { StatsFileCacheRow } from "../../../src/persistence/Services/StatsFileCache.ts";
import { StatsFileCacheRepositoryLive } from "../../../src/persistence/Layers/ProjectionStatsFileCache.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";

// A FRESH in-memory DB per test (provided inside each it.effect, not via the
// memoized it.layer) — listAll reads the whole table, so tests must not share rows.
const withRepo = <A, E>(effect: Effect.Effect<A, E, StatsFileCacheRepository>) =>
  effect.pipe(
    Effect.provide(StatsFileCacheRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  );

const session: StatsSession = {
  sessionId: "sess-1",
  projectId: "-Users-u-app",
  projectLabel: "app",
  projectPath: "/Users/u/app",
  projectKind: "real",
  branch: "main",
  model: "qwen/qwen3.6-35b-a3b",
  startedAt: "2026-06-10T10:00:00.000Z",
  durationMs: 60000,
  turns: 3,
  category: "dialog",
  isBackground: false,
  apiCalls: 5,
  tokens: { input: 5000, output: 200, thinking: 10, cached: 0 },
  avgLatencyMs: 8000,
  maxLatencyMs: 20000,
  toolCounts: { write_file: 2 },
  toolFailures: { write_file: 1 },
  errorTypes: {},
  autoAccepted: 1,
  rejected: 0,
  tokensByDay: { "2026-06-10": { input: 5000, output: 200, thinking: 10, cached: 0, apiCalls: 5 } },
  tokensByWeekdayHour: { "2:10": 5210 },
  present: true,
  lastSeenAt: IsoDateTime.make("2026-06-17T12:00:00.000Z"),
};

const row: StatsFileCacheRow = {
  filePath: "/root/projects/-Users-u-app/chats/sess-1.jsonl",
  mtimeMs: 1_780_000_000_000,
  sizeBytes: 4096,
  present: true,
  lastSeenAt: "2026-06-17T12:00:00.000Z",
  session,
};

it.effect("upserts then lists back the decoded row (session_json round-trips)", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      const rows = yield* repo.listAll();
      assert.equal(rows.length, 1);
      const [found] = rows;
      assert.equal(found.filePath, row.filePath);
      assert.equal(found.present, true);
      assert.equal(found.session.apiCalls, 5);
      assert.deepEqual(found.session.toolCounts, { write_file: 2 });
      assert.equal(found.mtimeMs, row.mtimeMs);
    }),
  ),
);

it.effect("upsert overwrites the row for the same file_path", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      yield* repo.upsert({ ...row, sizeBytes: 8192, session: { ...session, apiCalls: 9 } });
      const rows = yield* repo.listAll();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sizeBytes, 8192);
      assert.equal(rows[0].session.apiCalls, 9);
    }),
  ),
);

it.effect("markAbsent flips present→false and keeps the row (retain-after-delete)", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      yield* repo.markAbsent({ filePaths: [row.filePath], lastSeenAt: "2026-06-18T00:00:00.000Z" });
      const rows = yield* repo.listAll();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].present, false);
      assert.equal(rows[0].lastSeenAt, "2026-06-18T00:00:00.000Z");
    }),
  ),
);

it.effect("markAbsent with an empty list is a no-op", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      yield* repo.markAbsent({ filePaths: [], lastSeenAt: "2026-06-18T00:00:00.000Z" });
      const rows = yield* repo.listAll();
      assert.equal(rows[0].present, true);
    }),
  ),
);

it.effect("listAll returns empty on a fresh DB", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      assert.equal((yield* repo.listAll()).length, 0);
    }),
  ),
);

it.effect("removeByPaths hard-deletes the named rows (ghost purge)", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      yield* repo.upsert({ ...row, filePath: "/root/projects/x/chats/ghost.jsonl" });
      yield* repo.removeByPaths(["/root/projects/x/chats/ghost.jsonl"]);
      const rows = yield* repo.listAll();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].filePath, row.filePath);
    }),
  ),
);

it.effect("removeByPaths with an empty list is a no-op", () =>
  withRepo(
    Effect.gen(function* () {
      const repo = yield* StatsFileCacheRepository;
      yield* repo.upsert(row);
      yield* repo.removeByPaths([]);
      assert.equal((yield* repo.listAll()).length, 1);
    }),
  ),
);
