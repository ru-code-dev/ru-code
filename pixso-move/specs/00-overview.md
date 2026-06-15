# 00 — Overview: data model, contracts, endpoints

The single source of truth for the **shapes** every package agrees on. Tasks 2–5 implement this;
tasks 6–8 produce/consume it from the plugin.

---

## Glossary

| Term | Meaning |
|---|---|
| **designerId** | The designer's key. An opaque non-empty string the designer generates once in the plugin and saves. Used everywhere as both identity and access token. Called `authorKey` in the original sketch — we use **`designerId`** everywhere. |
| **node record** | One immutable submission: the serialized Pixso node subtree + a preview image + the designerId + when it arrived. Identified by a server-generated **`nodeId`**. |
| **processing result** | The outcome of running one configured prompt against one node record. Status-tracked. Identified by `(nodeId, resultTag)`. |
| **resultTag** | A short label naming what a prompt produces (e.g. `react`, `summary`, `a11y`). Lets multiple prompts run against the same node, each producing a distinct result. |

---

## Data model (sqlite, 2 tables)

### `nodes` — immutable ingestion records
| column | type | notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | the **nodeId**, server-generated UUID |
| `designer_id` | TEXT NOT NULL | indexed |
| `root_name` | TEXT NOT NULL | the selected node's name (for the developer list) |
| `nodes_json` | TEXT NOT NULL | serialized node subtree (JSON string) |
| `preview` | TEXT NOT NULL | base64 PNG (1×), no `data:` prefix |
| `added_at` | TEXT NOT NULL | ISO-8601 (`DateTime.formatIso`) |

Index: `idx_nodes_designer ON nodes(designer_id, added_at)`.
This table is **append-only** — never mutated after insert.

### `processing_results` — the job ledger AND the output
One row per `(node × configured prompt)`. Carries both lifecycle status and the produced result.
| column | type | notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | server-generated UUID |
| `designer_id` | TEXT NOT NULL | denormalized from the node (for key-gated reads), indexed |
| `node_id` | TEXT NOT NULL | FK → `nodes(id)` |
| `result_tag` | TEXT NOT NULL | from processor config |
| `status` | TEXT NOT NULL | `pending` \| `processing` \| `done` \| `error` |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | incremented each run attempt |
| `result` | TEXT | the LLM output text; NULL until `done` |
| `error` | TEXT | failure message; NULL unless `error` (or last failed attempt) |
| `created_at` | TEXT NOT NULL | when the job row was created |
| `started_at` | TEXT | when last claimed (→ `processing`) |
| `finished_at` | TEXT | when it reached `done`/`error` |

Constraints / indexes:
- `UNIQUE(node_id, result_tag)` → reconciliation is idempotent (`INSERT … ON CONFLICT DO NOTHING`).
- `idx_results_status ON processing_results(status)` → fast claim scan.
- `idx_results_designer_node ON processing_results(designer_id, node_id)` → fast reads.

> **Why this design (status off the `nodes` table):** the product owner requires full
> observability and control — monitor status, mark errors, retry later, finish unfinished work
> after a crash. We get all of that from the ledger while keeping `nodes` immutable. Adding a
> **new** prompt to config later auto-creates `pending` rows for existing nodes (reconciliation
> via the UNIQUE key), so new prompts backfill historical nodes.

---

## Processing lifecycle (state machine)

```
            reconcile (INSERT new (node,tag))
                       │
                       ▼
   ┌────────────┐ claim ┌─────────────┐ ACP ok ┌────────┐
   │  pending   │──────▶│ processing  │───────▶│  done  │
   └────────────┘       └─────────────┘        └────────┘
        ▲   ▲                  │ ACP fail
        │   │                  ▼
        │   │            ┌──────────┐
        │   └────────────│  error   │   (terminal; manual/future retry resets to pending)
        │  crash recovery└──────────┘
        │  (processing→pending on startup, unbounded; attempts NOT incremented by recovery)
```

- **claim** is atomic: `UPDATE … SET status='processing', started_at=…, attempts=attempts+1
  WHERE id=? AND status='pending'` — the row is only ours if `changes === 1`.
- **crash recovery** on startup: `UPDATE … SET status='pending' WHERE status='processing'` (work
  interrupted mid-flight resumes). Recovery does **not** bump `attempts`.
- **retry** (future): a config flag may auto-reset `error` rows with `attempts < maxAttempts` back
  to `pending`. The columns already support it; the loop hook is specified in
  [04-processor.md](./04-processor.md) but defaults OFF.

---

## HTTP API (plain HTTP + effect Schema; `effect/unstable/http`)

Auth: every endpoint requires the header **`x-designer-id: <designerId>`**. A request whose body
or query `designerId` disagrees with the header is rejected. Reads are scoped to that designerId —
you can only read what your key owns. CORS is open (`access-control-allow-origin: *`) because the
plugin posts cross-origin; `x-designer-id` is added to the allowed headers.

| Method | Path | Auth | Request | Response (200) | Errors |
|---|---|---|---|---|---|
| `POST` | `/ingest` | header | `IngestRequest` (body) | `IngestResponse` `{ nodeId }` | 400 invalid, 401 missing key |
| `GET` | `/nodes` | header | — | `NodeSummary[]` (this designer, newest first) | 401 |
| `GET` | `/nodes/:id` | header | — | `NodeRecord` (full, key-scoped) | 401, 404 |
| `GET` | `/processing-data` | header | `?nodeId=…` | `ProcessingResult[]` for that node | 400, 401, 404 |
| `OPTIONS` | `*` | — | CORS preflight | 204 | — |

> `GET /nodes` returns **summaries** (no `nodes_json`, to keep the list light) — id, rootName,
> addedAt, preview. `GET /nodes/:id` returns the full record including `nodes_json`.
> `GET /processing-data` returns all result rows (every `resultTag`, every status) for one node so
> the developer sees progress and errors, not just finished output.

### Contract shapes (effect Schema — defined in `@pixso-move/contracts`, see [02](./02-contracts.md))

```ts
DesignerId        = TrimmedNonEmptyString.pipe(Schema.brand("DesignerId"))   // ≤ 200 chars
NodeId            = TrimmedNonEmptyString.pipe(Schema.brand("NodeId"))
ResultTag         = TrimmedNonEmptyString.pipe(Schema.brand("ResultTag"))    // ≤ 64 chars
Base64Png         = TrimmedNonEmptyString                                    // ≤ ~8 MB guard

IngestRequest     = { designerId, rootName, nodesJson: string, preview: Base64Png }
IngestResponse    = { nodeId }
NodeSummary       = { nodeId, rootName, addedAt, preview }
NodeRecord        = { nodeId, designerId, rootName, nodesJson, preview, addedAt }
ProcessingStatus  = "pending" | "processing" | "done" | "error"
ProcessingResult  = { nodeId, resultTag, status, attempts, result: string|null,
                      error: string|null, createdAt, startedAt: string|null,
                      finishedAt: string|null }

// tagged errors:
IngestError       ("IngestError",     { message, status })    // 400/413
AuthError         ("AuthError",       { message, status })    // 401
NodeNotFoundError ("NodeNotFound",    { message, status })    // 404
```

`nodesJson` is carried as an opaque validated **string** (already-serialized JSON from the plugin).
The server stores it verbatim; it does not re-parse the node tree. (Keeps the contract simple and
the server agnostic to Pixso's node schema, which can change.)

---

## Processor config (`@pixso-move/processor`)

A plain TS file — `src/config.ts` — the operator edits:
```ts
export const processorConfig: ProcessorConfig = {
  entries: [
    { designerId: "dz_alice", prompt: "Generate a React component for this design.", resultTag: "react" },
    { designerId: "dz_alice", prompt: "Summarize this screen for a PM.",            resultTag: "summary" },
    { designerId: "dz_bob",   prompt: "List accessibility issues.",                 resultTag: "a11y" },
  ],
};
```
- The processor only acts on nodes whose `designerId` matches a config entry. Nodes from unknown
  designers are stored by the server but **never processed**.
- Multiple entries for one designer → multiple result rows per node (distinct `resultTag`).
- Adding/removing/editing entries is picked up on next process start (and reconciliation backfills
  new `(node, resultTag)` pairs for existing nodes).

---

## Deployment (decided)

- The **processor runs embedded in the server process** (one Effect runtime). Ingest calls the
  processor's `notify()` for low-latency pickup; a poll timer is the backstop. Single sqlite
  writer → no cross-process `SQLITE_BUSY`. See [05-embed.md](./05-embed.md).
- The DB file path comes from server config (default `./.data/pixso.sqlite`; `:memory:` in tests).
