import { assert, it } from "@effect/vitest";
import { beforeEach } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../../src/config.ts";
import { StatsScanner } from "../../../src/ru-fork/stats/StatsScanner.ts";
import { StatsLive } from "../../../src/ru-fork/stats/StatsLayers.ts";
import { SqlitePersistenceMemory } from "../../../src/persistence/Layers/Sqlite.ts";
// Verified specifier (serverRuntimeStartup.test.ts:2, fastShutdownOverlaySweep.test.ts:13).
import * as NodeServices from "@effect/platform-node/NodeServices";

// One ui_telemetry api_response line.
const apiResponseLine = (tokens: number, promptIndex: number, cwd: string) =>
  JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    cwd,
    gitBranch: "main",
    sessionId: "s",
    timestamp: "2026-06-10T10:00:00.000Z",
    systemPayload: {
      uiEvent: {
        "event.name": "qwen-code.api_response",
        "event.timestamp": "2026-06-10T10:00:00.000Z",
        model: "qwen/qwen3.6-35b-a3b",
        input_token_count: tokens,
        output_token_count: 10,
        cached_content_token_count: 0,
        thoughts_token_count: 0,
        duration_ms: 5000,
        prompt_id: `s########${promptIndex}`,
      },
    },
  });

// Seed `<projectsRoot>/<dir>/chats/<session>.jsonl`. Returns its absolute path.
// projectsBase is the scoped temp dir the scanner is pointed at (QWEN_RUNTIME_DIR),
// so each test gets its own isolated, auto-cleaned projects tree.
const seedFile = (projectsBase: string, dirName: string, sessionId: string, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const chatsDir = path.join(projectsBase, "projects", dirName, "chats");
    yield* fileSystem.makeDirectory(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
    yield* fileSystem.writeFileString(filePath, text);
    return filePath;
  });

const TEST_CWD = "/Users/u/WORKSPACE/Projects/app";
const TEST_DIR = "-Users-u-WORKSPACE-Projects-app";

// Full graph for one test, parameterised by the runtime temp baseDir. provideMerge
// (not mergeAll) so StatsLive's SqlClient/FileSystem/Path/ServerConfig requirements
// are actually satisfied — and every output (StatsScanner, FileSystem, Path,
// ServerConfig) is exposed to the test body.
const harness = (baseDir: string) =>
  StatsLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

// Create a scoped temp dir (outer NodeServices), point the scanner at it via
// QWEN_RUNTIME_DIR (so every test's projects tree is unique + auto-cleaned), then
// build + provide the harness for that baseDir to the body. ServerConfig depends on
// baseDir (a runtime value), so the harness is built inside the effect, not statically.
const runInTemp = <A, E>(
  body: (
    projectsBase: string,
  ) => Effect.Effect<A, E, StatsScanner | FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped();
    process.env.QWEN_RUNTIME_DIR = baseDir;
    return yield* body(baseDir).pipe(Effect.provide(harness(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

// The scanner reads process.env; clear any ambient/leftover override before each
// test (runInTemp then sets it to the test's own scoped dir).
beforeEach(() => {
  delete process.env.QWEN_RUNTIME_DIR;
});

it.effect("refresh parses every file and computes real fields", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      yield* seedFile(projectsBase, TEST_DIR, "s", [apiResponseLine(1000, 1, TEST_CWD), apiResponseLine(2000, 2, TEST_CWD)].join("\n"));
      const scanner = yield* StatsScanner;
      const snapshot = yield* scanner.refresh();
      assert.equal(snapshot.scannedFiles, 1);
      assert.equal(snapshot.parsedFiles, 1);
      assert.equal(snapshot.sessions.length, 1);
      const [session] = snapshot.sessions;
      assert.equal(session.tokens.input, 3000);
      assert.equal(session.apiCalls, 2);
      assert.equal(session.turns, 2);
      assert.equal(session.projectId, TEST_DIR);
      assert.equal(session.projectKind, "real");
      assert.equal(session.present, true);
    }),
  ),
);

it.effect("getSnapshot before any refresh is empty (pure read, never scans)", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      const snapshot = yield* scanner.getSnapshot();
      // The file exists on disk, but getSnapshot does not scan — DB is still empty.
      assert.equal(snapshot.sessions.length, 0);
      assert.equal(snapshot.scannedFiles, 0);
      assert.equal(snapshot.parsedFiles, 0);
    }),
  ),
);

it.effect("getSnapshot returns the stored rows after a refresh, without re-scanning", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      const filePath = yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      yield* scanner.refresh();
      const fileSystem = yield* FileSystem.FileSystem;
      // Delete the file AFTER refresh; getSnapshot must NOT notice (it never scans).
      yield* fileSystem.remove(filePath);
      const snapshot = yield* scanner.getSnapshot();
      assert.equal(snapshot.sessions.length, 1);
      assert.equal(snapshot.sessions[0].present, true); // still present — no scan ran
      assert.equal(snapshot.scannedFiles, 0);
    }),
  ),
);

it.effect("second refresh reuses unchanged files (parsedFiles = 0)", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      yield* scanner.refresh();
      const second = yield* scanner.refresh();
      assert.equal(second.parsedFiles, 0);
      assert.equal(second.sessions.length, 1);
    }),
  ),
);

it.effect("a changed file (new size) is re-parsed on refresh", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      const filePath = yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      yield* scanner.refresh();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(filePath, [apiResponseLine(1000, 1, TEST_CWD), apiResponseLine(5000, 2, TEST_CWD)].join("\n"));
      const second = yield* scanner.refresh();
      assert.equal(second.parsedFiles, 1);
      assert.equal(second.sessions[0].tokens.input, 6000);
    }),
  ),
);

it.effect("a new file in a new project dir is picked up on refresh", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      yield* scanner.refresh();
      yield* seedFile(projectsBase, "-tmp-other", "s2", apiResponseLine(7000, 1, "/tmp/other"));
      const second = yield* scanner.refresh();
      assert.equal(second.sessions.length, 2);
      assert.isTrue(second.sessions.some((session) => session.projectKind === "temp"));
    }),
  ),
);

it.effect("a deleted file is retained with present=false after refresh (retain-after-delete)", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      const filePath = yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      yield* scanner.refresh();
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(filePath);
      const second = yield* scanner.refresh();
      assert.equal(second.scannedFiles, 0);
      assert.equal(second.sessions.length, 1);
      assert.equal(second.sessions[0].present, false);
    }),
  ),
);

it.effect("files with no api_response are skipped (ghost: empty, or only tool/error)", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      // A real session, plus two "ghosts" with zero successful responses.
      yield* seedFile(projectsBase, TEST_DIR, "real", apiResponseLine(1000, 1, TEST_CWD));
      const emptyLine = JSON.stringify({ type: "user", cwd: "/tmp/ghost", sessionId: "g", timestamp: "2026-06-10T10:00:00.000Z" });
      yield* seedFile(projectsBase, "-tmp-empty", "empty", emptyLine);
      const errorOnlyLine = JSON.stringify({
        type: "system",
        subtype: "ui_telemetry",
        cwd: "/tmp/err",
        sessionId: "e",
        timestamp: "2026-06-10T10:00:00.000Z",
        systemPayload: {
          uiEvent: {
            "event.name": "qwen-code.api_error",
            "event.timestamp": "2026-06-10T10:00:00.000Z",
            error_type: "APIError",
          },
        },
      });
      yield* seedFile(projectsBase, "-tmp-erroronly", "erroronly", errorOnlyLine);
      const scanner = yield* StatsScanner;
      const snapshot = yield* scanner.refresh();
      assert.equal(snapshot.scannedFiles, 3); // all three files seen on disk
      assert.equal(snapshot.sessions.length, 1); // only the one with a response is a session
      assert.equal(snapshot.sessions[0].projectId, TEST_DIR);
    }),
  ),
);

it.effect("refresh with a missing projects root yields an empty snapshot (no throw)", () =>
  runInTemp(() =>
    Effect.gen(function* () {
      const scanner = yield* StatsScanner;
      const snapshot = yield* scanner.refresh();
      assert.equal(snapshot.sessions.length, 0);
      assert.equal(snapshot.scannedFiles, 0);
    }),
  ),
);

// Plant a row whose session_json is valid JSON but an OLDER StatsSession shape (missing
// today's required fields) — exactly what a persistent on-disk cache holds after the
// schema evolved. fromJsonString(StatsSession) rejects it, so a non-tolerant listAll
// fails the whole read and wedges both getSnapshot and refresh (the real-machine error).
const seedStaleCacheRow = (filePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO stats_file_cache (file_path, mtime_ms, size_bytes, present, last_seen_at, session_json)
      VALUES (${filePath}, ${1}, ${1}, ${1}, ${"2026-06-10T10:00:00.000Z"}, ${'{"sessionId":"old"}'})
    `;
  });

it.effect("getSnapshot skips a cached row whose session_json no longer matches the schema", () =>
  runInTemp(() =>
    Effect.gen(function* () {
      yield* seedStaleCacheRow("/old/stale.jsonl");
      const scanner = yield* StatsScanner;
      // Today this THROWS PersistenceSqlError (SchemaError) on the stale row; the fix
      // should drop the undecodable row and return cleanly.
      const snapshot = yield* scanner.getSnapshot();
      assert.equal(snapshot.sessions.length, 0);
    }),
  ),
);

it.effect("refresh recovers from an undecodable cached row and still parses on-disk files", () =>
  runInTemp((projectsBase) =>
    Effect.gen(function* () {
      yield* seedStaleCacheRow("/old/stale.jsonl");
      yield* seedFile(projectsBase, TEST_DIR, "s", apiResponseLine(1000, 1, TEST_CWD));
      const scanner = yield* StatsScanner;
      // Today refresh reads cachedRows (listAll) FIRST and dies before any upsert; the
      // fix should let it skip the stale row and still compute the real session.
      const snapshot = yield* scanner.refresh();
      assert.isTrue(snapshot.sessions.some((session) => session.projectId === TEST_DIR));
    }),
  ),
);
