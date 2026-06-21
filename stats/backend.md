# Stats (Analytics) — Backend implementation

Full per-file detail of the server side, generated from the current code. Pure modules
(no I/O, no Effect) are unit-tested in isolation; effectful modules are integration-tested
with a memory DB + temp filesystem. 52 tests total (see §9).

---

## 1. Contract — `packages/contracts/src/ru-fork/stats.ts`

The single source of truth shared by server and web (`@t3tools/contracts`).

**WS method names** (string literals, not added to upstream `WS_METHODS`):
```ts
STATS_GET_SNAPSHOT_METHOD = "stats.getSnapshot"
STATS_REFRESH_METHOD      = "stats.refresh"
```

**Schemas / types:**
- `StatsProjectKind` = `Literals(["real","temp"])`.
- `StatsCategory` = `Literals(["dialog","title","branch","commit","pr","memory","subagent","compress","service"])`.
- `StatsTokenBreakdown` = `{input,output,thinking,cached: Number}`.
- `StatsCountMap` = `Record(String, Number)` (tool counts, failures, error types).
- `StatsDayBucket` = `{input,output,thinking,cached,apiCalls: Number}`.
- `StatsSession` = the per-file row (every field below).
- `StatsSnapshot` = `{sessions: StatsSession[], generatedAt: IsoDateTime, scannedFiles, parsedFiles}`.
- `StatsError` = `TaggedErrorClass` with `{detail, cause?: Defect}` and a `message` getter.

**`StatsSession` fields:** `sessionId, projectId, projectLabel, projectPath,
projectKind, branch, model, startedAt, durationMs, turns, category, isBackground,
apiCalls, tokens, avgLatencyMs, maxLatencyMs, toolCounts, toolFailures, errorTypes,
autoAccepted, rejected, tokensByDay, tokensByWeekdayHour, present, lastSeenAt`.

**Wiring (`contracts/src/index.ts`, `rpc.ts`):**
- `index.ts`: `export * from "./ru-fork/stats.ts"`.
- `rpc.ts`: imports the two method consts + `StatsError`/`StatsSnapshot`; defines
  `WsStatsGetSnapshotRpc` and `WsStatsRefreshRpc` (both `payload: Struct({})`,
  `success: StatsSnapshot`, `error: StatsError`); registers both in `WsRpcGroup`.

---

## 2. `paths.ts` — projects-root resolution (pure)

`// @effect-diagnostics nodeBuiltinImport:off` — uses `node:path`/`node:os` directly.

- `resolveProjectsRoot({env, cliConfigDir})` → `<base>/projects` where `base` =
  `expandBaseDir(QWEN_RUNTIME_DIR)` if set & non-blank, else `cliConfigDir`.
- `expandBaseDir(dir)` → tilde (`~`, `~/x`) expansion against `os.homedir()`;
  relative paths resolved against home; absolute returned as-is.
- `chatsDirFor(root, projectDir)` → `<root>/<projectDir>/chats`.
- `isTempCwd(cwd)` → true for `/var/folders/`, `/private/var/folders/`, `/tmp/`,
  `/private/tmp/` prefixes (sandbox classification).
- `projectLabelFor(cwd)` → last non-empty path segment (fallback: the cwd itself).

Tested by `paths.test.ts` (env override, tilde, fallback, blank env, temp prefixes,
labels) — 6 tests.

---

## 3. `telemetry.ts` — JSONL extraction (pure, no throws)

`extractFileTelemetry(text): FileTelemetry` walks the file line-by-line:
- `JSON.parse` each non-blank line inside try/catch — **a malformed line is skipped**,
  never poisons the file.
- Structural guards only (`isObject`/`asString`/`asNumber`/`asBoolean`), no casts.
- Captures `cwd` (first non-empty), `branch` (**last** non-empty `gitBranch`),
  `sessionId` (first), and `firstUserText` (first `type:"user"` record's message).
- `userMessageText(message)` handles both `string` and `{parts:[{text}]}` shapes
  (joins part texts with `\n`).
- `extractUiEvent` maps the three `event.name`s to discriminated `TelemetryEvent`s:
  - `api_response` → tokens default to `0` when missing; `model`/`promptId` optional.
  - `tool_call` → dropped if `function_name` missing; `success` defaults `true`;
    `decision` only `auto_accept`/`reject`, else `undefined`.
  - `api_error` → `error_type` defaults `"UnknownError"`.
  - any event with no `event.timestamp` → dropped.

`FileTelemetry` = `{events, cwd, branch, sessionId, firstUserText}`.

Tested by `telemetry.test.ts` (every branch, malformed/blank handling, first-user-text
string/parts shapes, empty text) — 11 tests.

---

## 4. `instructions.ts` + `serviceSignatures.ts` — single-source service markers

`apps/server/src/textGeneration/instructions.ts` is a pure leaf module exporting the 4
instruction strings our text-generation calls send to qwen
(`THREAD_TITLE_INSTRUCTION`, `BRANCH_NAME_INSTRUCTION`, `COMMIT_MESSAGE_INSTRUCTION`,
`PR_CONTENT_INSTRUCTION`). `CliTextGeneration.ts` (title, branch) and
`TextGenerationPrompts.ts` (commit, pr) **use** these constants — they are the source.

`serviceSignatures.ts` **imports** them; each `ServiceSignature` carries
`{category, instruction, marker}` where `marker` is a distinctive substring of the
imported `instruction` (substring, not full string, so it stays robust to historical
wording variants):
```ts
SERVICE_SIGNATURES = [
  { title,  THREAD_TITLE_INSTRUCTION,   "titles for coding conversations" },
  { branch, BRANCH_NAME_INSTRUCTION,    "concise git branch name" },
  { commit, COMMIT_MESSAGE_INSTRUCTION, "git commit messages" },
  { pr,     PR_CONTENT_INSTRUCTION,     "pull request content" },
]
```
`serviceSignatures.test.ts` asserts `instruction.includes(marker)` for each → if a
prompt is reworded past its marker, a test fails loudly instead of silently
misclassifying. This is the true single-source fix (no hand-mirrored copy).

---

## 5. `aggregate.ts` — `FileTelemetry` → `StatsSession` (pure)

`aggregateSession({telemetry, projectDir, fileSessionId, nowIso}): StatsSession`.

**Constants:** `SIDE_QUERY_PREFIX="side-query:"`, `COMPRESS_PREFIX="compress-"`,
`REAL_TURN_MARKER="########"`.

`aggregateSession` takes a `timeZone: string` (IANA zone) — it's a **pure function of the
zone**, no ambient-TZ read. Day/hour are bucketed in that zone.

**Helpers:**
- `dayOf(ts, timeZone)` = local "YYYY-MM-DD" via a memoized `Intl.DateTimeFormat("en-CA",
  {timeZone, …})` (en-CA renders ISO order); returns `""` for an unparseable timestamp.
  Uses `Intl`, **not** `new Date()` (banned by the effect diagnostic on the server).
- `hourOf(ts, timeZone)` = local hour 0–23 via a memoized `Intl` `hourCycle:"h23"`
  formatter (0 for an unparseable timestamp).
- `weekdayOfDayKey(dayKey)` = weekday (Mon=0) of a `"YYYY-MM-DD"` key — calendar weekday,
  TZ-independent, from epoch-day math (1970-01-01 = Thursday) to avoid `new Date()`.
  The heatmap slot is `` `${weekdayOfDayKey(day)}:${hourOf(ts, timeZone)}` ``.
- An event with an unparseable timestamp is skipped from the time buckets (no crash).
- `countTurns(events)` = distinct `api_response` `prompt_id`s containing `########`.
- `classifyCategory(telemetry)` = the §5 ordering of the architecture doc:
  dialog (`########`) → memory (`side-query:`) → compress (`compress-`) →
  subagent (`#`) → service-signature content match → `service`.
- `dominant(counts, fallback)` = max-count key (the dominant model).

**Reduction (single passes over events):**
- token sums + latency (`latencySum`, `maxLatencyMs`) + `modelCounts` over `api_response`.
- `toolCounts`/`toolFailures` + `autoAccepted`/`rejected` over `tool_call`.
- `errorTypes` over `api_error`.
- `tokensByDay` (every event marks an activity day; `api_response` adds tokens+calls) and
  `tokensByWeekdayHour` (`api_response` visible tokens per slot).
- time span: `startedAt = sorted timestamps[0] ?? nowIso`, `durationMs = max(0, end-start)`.
- `category = classifyCategory(...)`, `isBackground = category !== "dialog"`.

**Output:** the full `StatsSession`; `model = dominant(modelCounts, "")`,
`avgLatencyMs = latencySum/apiCalls` (0 when none), `present:true`,
`lastSeenAt = IsoDateTime.make(nowIso)`.

Tested by `aggregate.test.ts` (token sums, latency, turns, background, tools/approvals,
errors, time span, day/weekday-hour buckets, all category branches, temp vs real, empty
file) — 22 tests.

---

## 6. `StatsScanner.ts` — the engine (effectful)

`StatsScanner` = `Context.Service` with `{getSnapshot, refresh}`; `StatsScannerLive =
Layer.effect`. Dependencies resolved from the runtime graph: `FileSystem`, `Path`,
`ServerConfig`, `StatsFileCacheRepository`.

**Helpers inside the layer:**
- `timeZone` = `Intl.DateTimeFormat().resolvedOptions().timeZone` (the machine-local IANA
  zone, read once), passed into every `aggregateSession({…, timeZone})` so day/hour
  buckets use the local day.
- `nowIso()` = `Effect.map(DateTime.now, DateTime.formatIso)` (codebase idiom).
- `listDiskFiles()` — walks `projectsRoot/*/chats/*.jsonl`; every FS op wrapped in
  `orElseSucceed`/`Effect.option` so a missing/failed dir or stat skips rather than
  fails. Per file collects `{filePath, projectDir, fileSessionId, mtimeMs, sizeBytes}`.
  `mtimeMs` from `Option.map(info.mtime, d=>d.getTime())` defaulting to `0`.
- `readText(file)` — `readFileString`; on failure logs `error` ("skipped unreadable
  file") and returns `Option.none` → caller keeps any prior row.
- `parseFile(file, when): ParseOutcome` — `{kind:"skip"}` (unreadable),
  `{kind:"ghost"}` (no `api_response`), or `{kind:"session", session}`.
- `reconcilePresence(row)` / `buildSnapshot(rows, when, scanned, parsed)` — present
  rows return their session as-is; absent rows get `present:false` + `lastSeenAt`
  reconciled from the column.

**`getSnapshot()`** — pure read: `nowIso` → `cache.listAll()` → `buildSnapshot(rows,
when, 0, 0)`. Wrapped in `tapError(logError)` + `mapError(StatsError)`. Never scans.

**`refresh()`** — `logDebug("refresh start")`; `listDiskFiles` + `cache.listAll`;
for each **changed** file (`existing` absent / not-present / mtime|size mismatch):
parse → skip (keep prior) | ghost (collect path) | upsert; then
`cache.removeByPaths(ghostPaths)` (purge stored ghosts); `cache.markAbsent(vanished)`
(retain-after-delete); `cache.listAll()` again → `buildSnapshot(..., diskFiles.length,
parsedFiles)`; `logDebug("refresh done", {scanned, parsed, ghosts, retained, total})`.
Wrapped in `tapError(logError)` + `mapError(StatsError)`.

**Logging:** start/end at `debug`; per-file read failures and the whole-refresh /
read failures at `error` (always in the server console) — per the repo's error-or-debug
rule.

Tested by `statsScanner.test.ts` (parse-all, pure-read-doesn't-scan, incremental reuse,
changed re-parse, new dir pickup, retain-after-delete, ghost skip incl. tool/error-only,
empty root) — 9 tests, with a per-test scoped temp dir pointed at via `QWEN_RUNTIME_DIR`
and a fresh memory DB.

---

## 7. Persistence

### `Migrations/032_Stats.ts`
`CREATE TABLE IF NOT EXISTS stats_file_cache (file_path TEXT PRIMARY KEY, mtime_ms
INTEGER, size_bytes INTEGER, present INTEGER DEFAULT 1, last_seen_at TEXT, session_json
TEXT)`. Registered in `Migrations.ts` as `[32, "Stats", Migration0032]`.

### `Services/StatsFileCache.ts`
- `StatsFileCacheRow` schema = `{filePath, mtimeMs, sizeBytes, present:boolean,
  lastSeenAt, session: StatsSession}`.
- `MarkAbsentInput` = `{filePaths: string[], lastSeenAt}`.
- `StatsFileCacheRepository` Service with `{listAll, upsert, markAbsent, removeByPaths}`,
  all returning `Effect<_, ProjectionRepositoryError>`.

### `Layers/ProjectionStatsFileCache.ts`
- `StatsFileCacheDbRow` = the row schema with `present: NonNegativeInt` (0/1 INTEGER →
  boolean by `rowToCacheRow`, the McpCatalog pattern) and `session:
  fromJsonString(StatsSession)`.
- `listRows` (`SqlSchema.findAll`, `ORDER BY file_path ASC`), `upsertRow`
  (`INSERT … ON CONFLICT(file_path) DO UPDATE`), `markAbsentRows`
  (`UPDATE … SET present=0 … WHERE file_path IN ${sql.in(...)}`).
- `removeByPaths` uses a raw `DELETE … WHERE file_path IN ${sql.in(...)}`.pipe(asVoid).
- All three list-bearing ops guard the **empty array** (an empty `sql.in` is invalid),
  returning `Effect.void`. Errors mapped via `toPersistenceSqlError("StatsFileCache.X")`.

Tested by `StatsFileCache.test.ts` (round-trip decode, overwrite, markAbsent retain,
empty no-ops, fresh-DB empty, removeByPaths purge + empty no-op) — 7 tests, fresh
`:memory:` DB **per test** (provided inside each `it.effect`, not a memoized `it.layer`,
because `listAll` reads the whole table).

---

## 8. Layer composition + wiring

- `StatsLayers.ts`: `StatsLive = StatsScannerLive.pipe(Layer.provide(StatsFileCacheRepositoryLive))`.
  The repo's `SqlClient` and the scanner's `FileSystem`/`Path`/`ServerConfig` are
  satisfied by the shared runtime graph where `StatsLive` is `provideMerge`d.
- `server.ts`: `import { StatsLive }`; `Layer.provideMerge(StatsLive)` immediately after
  `McpRuntimeServicesLive` in `RuntimeCoreDependenciesLive`.
- `ws.ts`: imports the two method consts + `StatsScanner`; `const statsScanner = yield*
  StatsScanner` in `makeWsRpcLayer`; two handlers keyed by the method literals, each
  `observeRpcEffect(method, statsScanner.getSnapshot()/refresh(), {"rpc.aggregate":"stats"})`.

This is the exact seam set MCP uses (DB-backed runtime service, registered at the same
line, yielded in the same ws scope).

---

## 9. Test inventory (server)

| File | Tests | Covers |
|---|---|---|
| `telemetry.test.ts` | 11 | every event branch, malformed/blank skip, dimension capture, firstUserText |
| `aggregate.test.ts` | 22 | sums, latency, turns, background, tools, errors, time, day/hour buckets (`timeZone:"UTC"`), all categories, temp/real, empty |
| `paths.test.ts` | 6 | env override, tilde, fallback, blank env, temp prefixes, labels |
| `statsScanner.test.ts` | 9 | read vs refresh, incremental, retain-after-delete, ghost skip, empty root |
| `StatsFileCache.test.ts` | 7 | round-trip, overwrite, markAbsent, removeByPaths, empty no-ops |
| `serviceSignatures.test.ts` | 2 | drift guard (marker ⊂ instruction), category coverage |

**54 server tests.** Verified state: `pnpm typecheck` 14/14, `pnpm lint` 0/0,
`pnpm test:fast` 1079 pass / 57 skip (only the pre-existing `bin.test.ts` qwen-absent
baseline fails, unrelated).

The web has **no test target** (repo constraint), so the client selectors are not
unit-tested — see `audit.md`.
