# Task 3 — Server (`@pixso-move/server`)

Effect + effect-platform HTTP server, `node:sqlite` persistence, 2-table schema, four endpoints,
key-gating, structured logging, launchable bootstrap. **Never crashes.** TDD, 100% (minus
`vendor/**`, `Migrations`, `bin.ts`). Every authored file ≤150 LOC.

## File budget
| Path | Responsibility | LOC |
|---|---|---|
| `src/vendor/NodeSqliteClient.ts` | **vendored** node:sqlite client (verbatim from ru-fork) | 277\* |
| `src/persistence/sqlite.ts` | `SqlitePersistenceMemory` + `makeSqlitePersistenceLive(dbPath)` + PRAGMA setup | ~45 |
| `src/persistence/migrate.ts` | `runMigrations` = run ordered migration list | ~20 |
| `src/persistence/migrations/001_nodes.ts` | `nodes` DDL | ~22\* |
| `src/persistence/migrations/002_results.ts` | `processing_results` DDL | ~28\* |
| `src/services/nodeStore.ts` | `NodeStore` tag + shape + `NodeRow` schema + decoders | ~45 |
| `src/services/nodeStoreLive.ts` | `NodeStoreLive` layer (insert/list/get/reads) | ~95 |
| `src/services/resultStore.ts` | `ResultStore` tag + shape + `ResultRow` schema + decoders | ~45 |
| `src/services/resultStoreLive.ts` | `ResultStoreLive` layer (reconcile/claim/complete/fail/recover/reads) | ~120 |
| `src/http/cors.ts` | cors headers + `corsLayer` (adds `x-designer-id`) | ~16 |
| `src/http/respond.ts` | `respondJson` + `respondError` (single error→response mapper) | ~30 |
| `src/http/route.ts` | `route(method, path, handler)` wrapper (catch + cors + never-throw) | ~30 |
| `src/http/auth.ts` | `requireDesignerId` | ~25 |
| `src/http/ingest.ts` | `POST /ingest` | ~35 |
| `src/http/nodes.ts` | `GET /nodes`, `GET /nodes/:id` | ~40 |
| `src/http/processing.ts` | `GET /processing-data` | ~30 |
| `src/http/routes.ts` | merge route layers + `corsLayer` | ~15 |
| `src/config.ts` | `ServerConfig` service + `layerTest` + defaults | ~50 |
| `src/serverLogger.ts` | logger layer (vendored-tiny, ported) | ~16 |
| `src/time.ts` | `nowIso` (shared) | ~5 |
| `src/httpServer.ts` | `HttpServerLive` (NodeHttpServer.layer) | ~20 |
| `src/server.ts` | `makeServerLayer` + `runServer` compose | ~70 |
| `src/bin.ts` | flag parse → provide config + AcpRunnerLive → runServer | ~30\* |

`*` = coverage-excluded (`vendor/**`, `migrations/**`, `bin.ts`). `tests/` mirrors `src/`.

> **Vendoring (conventions §2.3):** `vendor/NodeSqliteClient.ts` is copied verbatim from
> `apps/server/src/persistence/NodeSqliteClient.ts` (277 LOC, uses `node:sqlite`). Header-marked,
> not rewritten, not split, excluded from coverage. It exports the SqlClient layer constructors our
> `persistence/sqlite.ts` consumes.

## Persistence

### `persistence/sqlite.ts`
Mirror `apps/server/src/persistence/Layers/Sqlite.ts:18-76` but trimmed:
```ts
const setup = Layer.effectDiscard(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* runMigrations;
}));
export const SqlitePersistenceMemory = Layer.provideMerge(setup, NodeSqliteClient.layerMemory());
export const makeSqlitePersistenceLive = (dbPath: string) => /* mkdir parent, then */
  Layer.provideMerge(setup, NodeSqliteClient.layer({ filename: dbPath }));
export const persistenceLive = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), (c) => makeSqlitePersistenceLive(c.dbPath)));
// idiom from apps/server/src/persistence/Layers/Sqlite.ts:74
```

### `persistence/migrate.ts` — no Migrator dependency
Migrations are idempotent DDL (`CREATE TABLE IF NOT EXISTS …`), so just run them in order each
startup:
```ts
import m001 from "./migrations/001_nodes.ts";
import m002 from "./migrations/002_results.ts";
export const runMigrations = Effect.gen(function* () {
  for (const step of [m001, m002]) yield* step;          // ordered, idempotent
  yield* Effect.logDebug("migrations applied", { count: 2 });
});
```
> Simpler than the ru-fork `Migrator.fromRecord` registry (we have 2 tables) — fewer moving parts,
> fully covered by the migration test. DDL exactly per [00-overview.md](./00-overview.md): all
> columns, `UNIQUE(node_id, result_tag)`, the 3 indexes.

## Stores (all SQL lives here; interface ⟂ impl)

### `services/nodeStore.ts` — interface + row codec
```ts
export interface NodeStoreShape {
  readonly insert: (i: { designerId: DesignerId; rootName: string; nodesJson: string; preview: string })
    => Effect.Effect<{ nodeId: NodeId }>;
  readonly listSummaries: (d: DesignerId) => Effect.Effect<ReadonlyArray<NodeSummary>>;
  readonly getById: (d: DesignerId, n: NodeId) => Effect.Effect<NodeRecord | undefined>;
  readonly listNodeIds: (d: DesignerId) => Effect.Effect<ReadonlyArray<NodeId>>;     // processor
  readonly getForProcessing: (n: NodeId)
    => Effect.Effect<{ nodeId: NodeId; rootName: string; nodesJson: string } | undefined>;
}
export class NodeStore extends Context.Service<NodeStore, NodeStoreShape>()("pixso-move/NodeStore") {}
// NodeRow = Schema.Struct({ id, designer_id, root_name, nodes_json, preview, added_at });
// rowToSummary / rowToRecord via Schema.decode.
```

### `services/nodeStoreLive.ts` — `NodeStoreLive` layer
- `insert`: `nodeId = NodeId.make(crypto.randomUUID())`, `addedAt = yield* nowIso`, one `INSERT`.
- `listSummaries`: `SELECT id, root_name, preview, added_at … WHERE designer_id=? ORDER BY added_at
  DESC` → decode `NodeSummary[]` (no `nodes_json`).
- `getById`: `WHERE id=? AND designer_id=?` (key isolation in SQL) → `NodeRecord | undefined`.
- `listNodeIds`/`getForProcessing`: minimal projections for the processor.

### `services/resultStore.ts` — interface + row codec
```ts
export interface ResultStoreShape {
  readonly reconcile: (rows: ReadonlyArray<{ designerId; nodeId; resultTag }>) => Effect.Effect<number>;
  readonly claimNextPending: Effect.Effect<ClaimedJob | undefined>;
  readonly complete: (id: string, result: string) => Effect.Effect<void>;
  readonly fail: (id: string, error: string) => Effect.Effect<void>;
  readonly recoverInFlight: Effect.Effect<number>;
  readonly listByNode: (d: DesignerId, n: NodeId) => Effect.Effect<ReadonlyArray<ProcessingResult>>;
  readonly countPending: Effect.Effect<number>;
}
export type ClaimedJob = { id: string; designerId: DesignerId; nodeId: NodeId; resultTag: ResultTag };
export class ResultStore extends Context.Service<ResultStore, ResultStoreShape>()("pixso-move/ResultStore") {}
```

### `services/resultStoreLive.ts` — `ResultStoreLive` layer
- `reconcile`: `INSERT INTO processing_results (…) VALUES … ON CONFLICT(node_id, result_tag) DO
  NOTHING`; id = `crypto.randomUUID()`, `created_at = yield* nowIso`, `status='pending'`. Returns
  inserted count.
- `claimNextPending`: `SELECT … WHERE status='pending' ORDER BY created_at LIMIT 1`, then
  `UPDATE … SET status='processing', started_at=?, attempts=attempts+1 WHERE id=? AND
  status='pending'`; return the job **only if `changes === 1`** (else `undefined` — lost race).
- `complete`/`fail`: set terminal `status` + `finished_at` + `result`/`error`.
- `recoverInFlight`: `UPDATE … SET status='pending' WHERE status='processing'` (no attempts bump).
- `listByNode`: `WHERE designer_id=? AND node_id=?` → `ProcessingResult[]`. `countPending` for tests.

## HTTP (effect/unstable/http, `HttpRouter.add` — no base-path helper)

### `http/cors.ts`
```ts
export const corsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const corsAllowedHeaders = ["content-type", "x-designer-id"] as const;
export const corsHeaders = { "access-control-allow-origin": "*",
  "access-control-allow-methods": corsAllowedMethods.join(", "),
  "access-control-allow-headers": corsAllowedHeaders.join(", ") } as const;
export const corsLayer = HttpRouter.cors({ allowedMethods: [...corsAllowedMethods],
  allowedHeaders: [...corsAllowedHeaders], maxAge: 600 });
```

### `http/respond.ts` — the single mapper (DRY)
```ts
export const respondJson = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: corsHeaders });
export const respondError = (e: AuthError | IngestError | NodeNotFoundError) =>
  respondJson({ error: e.message }, e.status);
```

### `http/route.ts` — the single wrapper (DRY, never-throws)
```ts
export const route = (method, path, handler: Effect.Effect<HttpServerResponse, KnownError, …>) =>
  HttpRouter.add(method, path, handler.pipe(
    Effect.catchTags({ AuthError: respondError, IngestError: respondError, NodeNotFoundError: respondError }),
    Effect.catchAllCause((cause) =>          // defects: log + 500, process survives
      Effect.zipRight(Effect.logError("route defect", { path, cause: Cause.pretty(cause) }),
                      respondJson({ error: "Internal error." }, 500))),
  ));
```
Every route is defined via `route(...)`; **no route re-implements error handling or cors.**

### `http/auth.ts`
`requireDesignerId: Effect<DesignerId, AuthError, HttpServerRequest>` — read `x-designer-id`, decode
through `DesignerId`; missing/blank/invalid → `new AuthError({ message:"Missing or invalid designer
key.", status:401 })`.

### Route handlers (each tiny, identical shape)
| File | Route | Body |
|---|---|---|
| `http/ingest.ts` | `POST /ingest` | auth → `schemaBodyJson(IngestRequest)` (fail→`IngestError(400)`) → assert `body.designerId === key` (else `AuthError(401)`) → preview-size guard (`IngestError(413)`) → `NodeStore.insert` → `Processor.notify` (task 5) → `respondJson({ nodeId }, 200)`; `logDebug("ingest stored", { nodeId })` |
| `http/nodes.ts` | `GET /nodes` | auth → `NodeStore.listSummaries` → 200 |
| `http/nodes.ts` | `GET /nodes/:id` | auth → `NodeStore.getById` → 200 or `NodeNotFoundError(404)` |
| `http/processing.ts` | `GET /processing-data` | auth → decode `?nodeId` (`IngestError(400)`) → ensure node owned (`NodeNotFoundError(404)`) → `ResultStore.listByNode` → 200 |

### `http/routes.ts`
Merge the four `route(...)` layers; provide `corsLayer`. (`OPTIONS` preflight handled by `corsLayer`.)

## Config / logger / bootstrap
- `config.ts`: `ServerConfig = Context.Service<…>("pixso-move/ServerConfig")` with `{ host, port,
  dbPath, logLevel, cliJs, cliHome? }`; `ServerConfig.layerTest(overrides)`; defaults `host
  127.0.0.1`, `port 7787`, `dbPath ./.data/pixso.sqlite`, `logLevel Debug`.
- `serverLogger.ts`: port `apps/server/src/serverLogger.ts:8-16` (consolePretty + MinimumLogLevel).
- `httpServer.ts`: `HttpServerLive = NodeHttpServer.layer(NodeHttp.createServer, { host, port })`
  (dynamic import, mirror `server.ts:100-112`).
- `server.ts`: `makeServerLayer = Layer.mergeAll(HttpRouter.serve(routes), httpListening?)` provided
  with `persistenceLive`, `ServerLoggerLive`, `NodeStoreLive`, `ResultStoreLive`, `ProcessorLive`
  (task 5), over `PlatformServicesLive`/`NodeServices`. `runServer = Layer.launch(makeServerLayer)`.
- `bin.ts`: parse `--port/--host/--db/--cli-js` → provide `ServerConfig` + `AcpRunnerLive` →
  `runServer` (coverage-excluded).

## TDD — tests first (100%)
**migrations** (`tests/persistence`): run `SqlitePersistenceMemory`; assert both tables + 3 indexes +
the unique constraint exist (query `sqlite_master`); idempotent (build layer twice).

**nodeStore**: insert returns fresh id + persists all columns, `added_at` ISO (pin clock);
`listSummaries` excludes `nodes_json`, newest-first, **isolated by designerId**; `getById` undefined
for wrong key and missing id; `listNodeIds`/`getForProcessing` projections correct.

**resultStore**: `reconcile` inserts only missing pairs, idempotent (2nd call → 0); `claimNextPending`
flips one row to `processing` (attempts=1) and returns it; pre-claimed row → loser gets `undefined`;
`complete`/`fail` set terminal status + `finished_at` + result/error; `recoverInFlight` flips
`processing→pending` without bumping attempts; `listByNode` scoped + all tags; `countPending`.

**http** (`tests/http`): exercise each route Effect with a constructed `HttpServerRequest` over a
layer = routes + `SqlitePersistenceMemory` + stores + test logger + a **no-op `Processor`** +
`ServerConfig.layerTest`. Cover: missing/blank/invalid key→401; ingest body/header mismatch→401;
invalid body→400; oversize preview→413; happy→200 + body + `corsHeaders`; `/nodes/:id` unknown→404,
wrong-key→404; `processing-data` missing/invalid `nodeId`→400, unknown node→404, happy→array.
**Catch-all**: inject a store layer whose method dies → handler returns 500 `{error}` and `logError`
fired (proves never-crash). `respond.ts`/`route.ts`/`auth.ts`/`cors.ts`/`config.ts`/`time.ts` each
fully covered.

## Acceptance
- [ ] Both tables + indexes + unique constraint; key-gating enforced in SQL and at the edge.
- [ ] Every route via `route()`; one `respondError`; no duplicated handling; defects → 500+log.
- [ ] `logError`/`logDebug` only; ingest steps logged; server cannot crash.
- [ ] Every authored file ≤150 LOC; `vendor/` isolated; `tsc`/oxlint clean; coverage 100% (excl.).
