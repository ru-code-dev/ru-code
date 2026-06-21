# Stats (Analytics) — Architecture

Generated from the current implementation in worktree `stats-logic` (uncommitted). This
document describes the system as it actually is in the code, not as it was planned.

---

## 1. Purpose

A read-only **Analytics** panel in Settings («Аналитика») that surfaces CLI usage
analytics — tokens, models, projects, branches, tools, reliability, activity heatmap,
and a per-session table — computed entirely from **qwen's on-disk JSONL chat
transcripts**. Nothing is faked; every number is derived from real telemetry events.

Scope is a **single user / single machine** personal analytics tool. The design choices
(client-side aggregation, whole-table cache reads, UTC day bucketing) are appropriate
for that scope and are called out where they impose a ceiling.

---

## 2. Data source — qwen transcripts

qwen stores one JSONL file per chat session at:

```
<projectsRoot>/<encodedCwd>/chats/<sessionId>.jsonl
```

`projectsRoot` is resolved by `paths.ts`:
- `QWEN_RUNTIME_DIR` env (tilde/relative-expanded against `$HOME`) if set, else
- `ServerConfig.cliConfigDir` (`{home}/$CLI_DIR`), then `/projects`.

Each `.jsonl` line is one record. Two things are read:

**(a) Base record fields** (any record): `cwd`, `gitBranch`, `sessionId`, `type`,
and for `type:"user"` records the `message` text.

**(b) `ui_telemetry` events** — records with `type:"system"`, `subtype:"ui_telemetry"`,
payload at `systemPayload.uiEvent`, keyed by `event.name`:

| `event.name` | fields consumed |
|---|---|
| `qwen-code.api_response` | `event.timestamp`, `model`, `input_token_count`, `output_token_count`, `cached_content_token_count`, `thoughts_token_count`, `duration_ms`, `prompt_id` |
| `qwen-code.tool_call` | `event.timestamp`, `function_name`, `success`, `decision` (`auto_accept`/`reject`) |
| `qwen-code.api_error` | `event.timestamp`, `error_type` |

### prompt_id is the spine of classification

- `<sessionId>########<n>` — a **real interactive turn** (dialog).
- `side-query:auto-memory-recall` — qwen's background memory recall.
- `compress-<n>` — qwen's context compression.
- `<sessionId>#<agent>#<n>` — a subagent run (Explore, etc.).
- a **bare hash** (`00d94578d66ad`) — a one-shot call: either **our** server's
  text-generation (thread title / branch / commit / PR) **or** a user's `qwen -p`.
  These are structurally identical (same id shape, same ~16K input); the only
  discriminator is the **content** of the first user message.

---

## 3. The atomic unit: `StatsSession`

**One chat file = one `StatsSession`.** The server reduces each file's telemetry to a
flat, fully-numeric `StatsSession` (contract: `packages/contracts/src/ru-fork/stats.ts`)
and returns the per-session list; the **web aggregates** that list into every widget,
client-side, so filters re-render instantly with no round-trips.

A `StatsSession` carries scalar rollups (`tokens`, `apiCalls`, `avgLatencyMs`,
`toolCounts`, `errorTypes`, …) **plus two time-grain rollups** that make time views
correct:
- `tokensByDay`: `Record<"YYYY-MM-DD"(UTC), {input,output,thinking,cached,apiCalls}>`
- `tokensByWeekdayHour`: `Record<"weekday:hour"(Mon=0,UTC), visibleTokens>`

…and a `category` (see §5), `isBackground`, `present` (retain-after-delete flag), and
`lastSeenAt`.

---

## 4. End-to-end data flow

```
 qwen JSONL files  ──┐
                     │  (read-only)
   ┌─────────────────▼──────────────────────────── SERVER (apps/server) ──────────┐
   │ StatsScanner.refresh():                                                       │
   │   listDiskFiles → stat each *.jsonl (mtime+size)                              │
   │   for each CHANGED file:  readText → extractFileTelemetry → aggregateSession  │
   │     · no api_response  → GHOST (skip + purge any stored row)                  │
   │     · else             → upsert StatsSession into stats_file_cache (SQLite)   │
   │   vanished files → markAbsent (present=0, retained)                           │
   │   return all rows as StatsSnapshot                                            │
   │ StatsScanner.getSnapshot():  pure read of stats_file_cache → StatsSnapshot    │
   └───────────────▲───────────────────────────────────────────────┬──────────────┘
                   │ WS RPC: stats.getSnapshot / stats.refresh      │ StatsSnapshot
   ┌───────────────┴───────────────────────────────── WEB (apps/web) ─────────────┐
   │ useStatsData():  on open → getSnapshot (instant) then refresh; ⟳ → refresh    │
   │   → store.setSnapshot(sessions, generatedAtMs)                                │
   │ useStatsView():  buildView(sessions, filters, granularity, anchorMs)          │
   │   → filterSessions → per-widget selectors (windowed by tokensByDay)           │
   │ Dashboard widgets render the StatsView                                        │
   └──────────────────────────────────────────────────────────────────────────────┘
```

### Two server operations (CQRS-style read/refresh split)

| RPC | Effect | Touches disk? | Use |
|---|---|---|---|
| `stats.getSnapshot` | pure DB read (`listAll`) | **no** | instant safety-net load on panel open |
| `stats.refresh` | scan → re-parse changed → save → return | **yes** | open (after the read) + the ⟳ button |

**Client triggers (nothing on a timer, nothing in the background):**
- **Open panel** → `getSnapshot` (instant last-good) → then `refresh` (bring current).
  A failed refresh keeps the read's data on screen.
- **⟳ button** → `refresh` only (via a store `refreshNonce` bump).

This satisfies "the server does nothing until you ask" by construction.

---

## 5. Session categories («Тип»)

Roughly **half** of all chat files are not real conversations — they are one-shot /
automatic sessions qwen or our own server spawns per message. The `category` field
(contract `StatsCategory`) makes them visible and filterable.

Classification (`aggregate.ts::classifyCategory`, first match wins):

| order | category | signal | bucket |
|---|---|---|---|
| 1 | `dialog` | a `prompt_id` containing `########` | **Диалог** |
| 2 | `memory` | a `prompt_id` starting `side-query:` | Фон |
| 3 | `compress` | a `prompt_id` starting `compress-` | Фон |
| 4 | `subagent` | a `prompt_id` containing `#` | Фон |
| 5 | `title`/`branch`/`commit`/`pr` | first user message contains one of our `SERVICE_SIGNATURES` markers | Фон |
| 6 | `service` | anything else (unknown one-shot, incl. real `qwen -p`) | Фон |

- `isBackground = category !== "dialog"`. The **«Фон»** traffic filter = everything
  that isn't dialog; the default filter is **«Диалог»**, so the panel shows only real
  conversations until you switch.
- `turns` counts only `########` ids — automatic sessions report 0 turns.
- The `title/branch/commit/pr` markers match our server's text-generation prompts.
  The instruction strings are defined once in
  `apps/server/src/textGeneration/instructions.ts`, **used** by `CliTextGeneration.ts`
  / `TextGenerationPrompts.ts`, and **imported** by `serviceSignatures.ts` (which keeps
  a distinctive substring marker per instruction). A drift-guard test asserts every
  marker is a substring of its instruction, so rewording a prompt past its marker fails
  a test rather than silently misclassifying. **Honest caveat:** this is still the
  *only* available signal (the prompt_id is identical to a user `qwen -p`), so a real
  `qwen -p "hi"` is indistinguishable from an unknown service call and lands in
  `service`/Фон.

---

## 6. Time model — calendar-day windowing

Filters are **calendar-day aligned** (`Сегодня · 7 · 14 · 30 · Всё время`). Because
every boundary is a midnight, a per-**day** rollup (`tokensByDay`) is exact:

- a session is "in window" if it has activity on any in-window day (`hasWindowActivity`);
- token metrics, the usage-over-time chart, composition, and project/model/branch token
  totals are **summed from the in-window days** (`windowedTokens`), so a multi-day
  session contributes to each day it actually touched — no single-timestamp pinning;
- `Всё время` = `"all"` = no cutoff (truly all history, not "48 days").

Day/hour keys are computed in the **machine-local timezone** on both sides: the server
buckets via `Intl` in the local IANA zone (`aggregateSession` takes the zone as a
parameter; the scanner passes `Intl.DateTimeFormat().resolvedOptions().timeZone`), and
the client computes the browser-local day. Same machine ⇒ same zone ⇒ keys line up, so
**"Сегодня" means your real local today.** (Edge case: a *remote* server in a different
timezone would key by the *server's* local day — an accepted trade for the ~1% remote
case. True viewer-local-today with a remote server would require shipping hour-grain
buckets and folding them client-side.)

`tools / errors / latency / approvals` remain **session-grain** over the filtered set
(they have no time axis). The heatmap uses `tokensByWeekdayHour` (collapses dates, so it
shows the filtered sessions' weekday/hour pattern, not a date-scoped slice). These
grain choices are deliberate and noted in the audit.

---

## 7. Persistence — incremental, durable cache

`stats_file_cache` (migration `032_Stats.ts`): one row per chat file, keyed by absolute
`file_path`, carrying `(mtime_ms, size_bytes)` for change detection, `present` (0/1),
`last_seen_at`, and `session_json` (the computed `StatsSession`).

- **Incremental:** `refresh` re-parses only files whose `mtime`/`size` changed.
- **Retain-after-delete:** a vanished file's row is kept with `present=0`; the snapshot
  still returns it (reconciled to `present:false`).
- **Ghost purge:** files with no `api_response` are never stored, and any previously
  stored ghost row is hard-deleted (`removeByPaths`).
- Unreleased feature → **no migrations/back-compat**; the cache is fully rebuildable.

---

## 8. Module map

```
packages/contracts/src/ru-fork/stats.ts      contract: StatsSession, StatsSnapshot,
                                              StatsCategory, StatsError, method consts
packages/contracts/src/{index,rpc}.ts        re-export + 2 RPC defs + group registration

apps/server/src/ru-fork/stats/
  paths.ts              resolve projectsRoot, chatsDir, temp/label classification (pure)
  telemetry.ts          JSONL → events + cwd/branch/sessionId + firstUserText (pure)
  serviceSignatures.ts  category markers, imported from textGeneration/instructions.ts (pure)
  aggregate.ts          FileTelemetry → StatsSession; classifyCategory; local-zone time buckets (pure)
apps/server/src/textGeneration/instructions.ts   single source for the 4 text-gen
                                              instruction strings (used by textGeneration,
                                              imported by serviceSignatures)
  StatsScanner.ts       the engine: getSnapshot (read) + refresh (scan) — effectful
  StatsLayers.ts        StatsLive = StatsScannerLive ⊕ repo
apps/server/src/persistence/
  Migrations/032_Stats.ts                 table DDL
  Services/StatsFileCache.ts              repo Service + row schema
  Layers/ProjectionStatsFileCache.ts      repo Live (SqlSchema)
apps/server/src/{server,ws}.ts            wiring seams (provideMerge + 2 handlers)

apps/web/src/rpc/wsRpcClient.ts           stats namespace (getSnapshot/refresh)
apps/web/src/ru-fork/stats/
  model/{types,catalog,filterOptions,format,selectors}.ts   types + pure aggregation
  store.ts              zustand state + useStatsView
  useStatsData.ts       the fetch hook (open→read+refresh, ⟳→refresh)
  components/*          dashboard, filter bar, refresh control, widgets, sheets
```

See `backend.md` and `frontend.md` for full per-file detail, and `audit.md` for the
code-quality assessment.
