# Stats (Analytics) — Code Quality Audit

Independent audit of the current implementation (uncommitted, worktree `stats-logic`).
Read every changed/new file in its final state. No code was changed for this audit.
Honest assessment, issues ranked by severity, with file references.

---

## Verdict

**Yes — this is senior-level, production-ready code _for its stated scope_** (a
single-user / single-machine personal analytics panel). It is well-structured, idiomatic
Effect-TS, strongly typed (no `any`/`unknown`/casts in our surface), resilient to bad
input, and the server is genuinely well-tested (52 tests). The architecture (per-file
session as the atom, incremental durable cache, CQRS read/refresh split, client-side
aggregation) is sound and clearly reasoned.

It is **not** "ship to thousands of users" hardened, and it shouldn't pretend to be —
there are a handful of deliberate trade-offs (documented below) plus three genuine nits
worth tightening. None are blockers for the intended use.

Overall grade: **A− / strong senior.** The gaps are in *test reach on the client* and a
couple of *single-source-of-truth* shortcuts, not in the core engineering.

---

## Strengths (what's done right)

- **Pure/effectful separation.** `telemetry`, `aggregate`, `paths`, `serviceSignatures`,
  and the entire web `selectors` are pure and independently testable; only `StatsScanner`
  and the repo are effectful. This is the single biggest reason the code is trustworthy.
- **Idiomatic Effect + persistence.** `Context.Service` + `Layer.effect`, `SqlSchema`
  repos, tagged `StatsError`, `Effect.option`/`orElseSucceed` for "skip on failure",
  `DateTime.now` idiom, `sql.in` with empty-array guards. Matches the MCP feature's
  conventions exactly (same wiring seams).
- **Error resilience is real, not decorative.** A malformed JSONL line, a locked file, a
  missing dir — each is skipped/logged, never poisons the snapshot or fails the refresh.
  On the client, a failed `refresh` keeps the last-good data on screen (`setStatus` never
  touches `sessions`). The read/refresh split means a refresh error can't blank the panel.
- **Type discipline.** Structural guards (`isObject`/`asString`/`asNumber`) instead of
  casts; the contract is the single source of truth and the web re-exports it; the
  category union is shared so server and client can't drift on the enum.
- **Correct, non-trivial modeling.** Incremental cache (mtime+size change detection),
  retain-after-delete (`present=0`), ghost detection + purge, faceted filter dropdowns,
  and genuinely correct per-day token attribution (`tokensByDay`) so a multi-day session
  contributes to each day — a real improvement over single-timestamp pinning.
- **Server test coverage is strong.** Every telemetry/aggregate branch, every category
  path, scanner integration (incremental, retain, ghost, empty root), and cache
  round-trip — with proper isolation (fresh `:memory:` DB per test, per-test scoped temp
  dir via `QWEN_RUNTIME_DIR`).
- **Security is clean.** Read-only w.r.t. transcripts; only writes its own cache table.
  Parameterized SQL throughout; `JSON.parse` wrapped; no injection or path-traversal
  surface; tilde expansion is bounded to `$HOME`.

---

## Issues

### High — none
No correctness-breaking or security defects found.

### Medium

**M1. Mixed metric grain can mislead on boundary sessions.**
`selectors.ts::buildKpis` windows token totals **and** `apiCalls` (from `tokensByDay`),
but `errors`/`toolCalls` are whole-session and `avgLatencyMs` is weighted by
*whole-session* `apiCalls`. So for a session straddling the window edge:
- `errorRatePct = errors(whole) / apiCalls(windowed)` — mixed basis;
- the displayed "API calls" tile (windowed) can disagree with the latency denominator
  (whole-session).
Impact is small (only boundary-straddling sessions, rare for sub-day windows) and it's a
deliberate choice (tools/errors have no time axis), but it's a real inconsistency a
reviewer should know. If it ever matters, drive everything time-based from `tokensByDay`.

**M2. `SERVICE_SIGNATURES` hand-mirrored, not imported — drift risk. ✅ FIXED.**
*Was:* `serviceSignatures.ts` copied substrings of the prompts in `textGeneration/*`
with a "keep in sync" comment — not a true single source, so a reworded prompt would
silently drop title/branch/commit/PR sessions into `service`/Фон.
*Now:* the instruction strings live in a single leaf module
`apps/server/src/textGeneration/instructions.ts`, **used** by `CliTextGeneration.ts` /
`TextGenerationPrompts.ts` and **imported** by `serviceSignatures.ts`; a drift-guard
test (`serviceSignatures.test.ts`) asserts every marker is a substring of its
instruction, so any future reword fails a test instead of misclassifying silently.

**M3. Title detection is an inherent content heuristic.**
Even done perfectly, distinguishing our `title`/`branch`/`commit`/`pr` calls from a real
`qwen -p` is *only* possible by content — the `prompt_id` and input size are identical
(verified). So `service` is a true catch-all that also swallows real `qwen -p` prompts
into Фон. This is correct given the data (documented), but it means hand-run one-shots
are hidden by default and a future qwen-internal call type would land in `service`.

**M4. Client selectors are unit-untested.**
`apps/web` has no test target (repo-wide constraint), so `selectors.ts` — the most
complex client logic (windowing, faceting, all the `buildX`) — has **zero** tests. The
server compute is well covered, but the client recomputation of windows/series/heatmap is
only protected by typecheck. For "senior production," this is the most notable gap; it's a
repo constraint, not negligence, but worth flagging loudly.

**M5. UTC-day window semantics. ✅ FIXED (same-machine).**
*Was:* "Сегодня"/"7 дней" were **UTC** calendar days, so a user off UTC saw late-evening
local activity land in the next day's bucket — not "local today". The session-time
*display* (`formatDateTime`) was likewise UTC.
*Now:* day/hour are bucketed in the **machine-local** zone — `aggregateSession` takes the
zone as a parameter (pure, no ambient read), the scanner passes
`Intl.DateTimeFormat().resolvedOptions().timeZone`, the client computes the browser-local
day, and `formatDateTime` renders the local clock. Same machine ⇒ same zone ⇒ "Сегодня"
= your real local today, and session times show your local clock.
*Remaining (documented) limitation:* a **remote** server in a different timezone keys by
the *server's* local day — true viewer-local-today with a remote server would need
hour-grain buckets folded client-side (the ~1% case; intentionally not done).

### Low

- **L1. Whole-table reads / no pagination.** `getSnapshot` and `refresh` both `listAll()`
  the entire cache (refresh does it twice) and JSON-decode every `session_json`. Fine for
  thousands of sessions; a clear O(N) ceiling at very large histories. No streaming/paging.
- **L2. Ghosts re-read every refresh.** Ghost files are never cached, so each `refresh`
  re-reads+re-parses all of them (O(ghosts) wasted I/O). Small, but unbounded by design.
- **L3. No per-file read timeout.** A genuinely hung read (stalled network mount) could
  stall a refresh until the WS times out. The user explicitly declined a timeout; local
  disk won't hit this.
- **L4. `subagent` detection is loose.** `classifyCategory` treats any non-dialog,
  non-side-query, non-compress `prompt_id` containing `#` as `subagent`. Real subagent ids
  are the only `#`-bearing ones in practice, but it's a structural assumption, not a guard.
- **L5. `process.env` read inside the engine.** `StatsScanner.listDiskFiles` calls
  `resolveProjectsRoot({env: process.env, …})`, coupling to a global. Tests must mutate
  `process.env` (they do, with `beforeEach` cleanup). Injecting env via `ServerConfig`
  would be cleaner and remove the test-global dance.
- **L6. `anchorMs` = last-refresh time, not real now.** If the panel sits open without a
  refresh, "Сегодня" is anchored to the last refresh. Negligible given fetch-on-open.
- **L7. Heatmap can't be date-window-scoped.** `tokensByWeekdayHour` collapses dates, so
  for a 7-day window the heatmap reflects the filtered sessions' whole weekday/hour
  pattern, not just the in-window dates. Acceptable (it's a "when do I work" view).

### Nits

- **N1. Duplicated `DEFAULT_FILTERS`.** Defined in both `store.ts` and
  `StatsFilterBar.tsx`. They were kept in sync this round (traffic → "turns" in both), but
  it's a real drift hazard — extract one shared const.
- **N2. `model/types.ts` has `import` statements mid-file** (lines 28, 32, after exports).
  Works (hoisted), but unconventional; move imports to the top.
- **N3. `StatsFilterBar` runs `filterSessions` 3× per render** (one per faceted dropdown,
  each a full pass), plus the main view's pass = 4 passes over all sessions. Memoized on
  `[sessions, filters, anchorMs]`, so only on change, but not free at large N.
- **N4. Dead-ish fallback.** `aggregate.ts` still has `startedAt = … ?? nowIso` for the
  empty-events case, now unreachable in production (ghosts are skipped before aggregate);
  harmless but slightly misleading. The empty-file unit test documents it.
- **N5. Service markers under-tested.** `aggregate.test.ts` asserts the `title` marker
  path but not `branch`/`commit`/`pr` individually.

---

## Per-area summary

| Area | Assessment |
|---|---|
| Contracts | Clean, complete, single-source-of-truth, shared enum. |
| Telemetry parsing | Excellent — pure, guarded, never throws, fully branch-tested. |
| Aggregation | Strong; one heuristic (categories) that's inherently content-based (M3) + a mirrored marker list (M2). |
| Scanner / persistence | Solid; incremental, durable, resilient; whole-table reads are the only scale concern (L1). |
| Wiring | Minimal, idiomatic, matches MCP seam set exactly. |
| Web data layer | Good; read/refresh + status handling is thoughtful; selectors untested (M4). |
| Web UI | Unchanged widgets; data wiring is clean; faceted filters are a nice touch. |
| Tests | Server: strong. Client: none (repo constraint). |
| Security | Clean. |

---

## Recommendations (in priority order)

1. ✅ **(M2/N5) — DONE.** Instruction constants centralized in
   `textGeneration/instructions.ts`, imported by `serviceSignatures.ts`, with a
   drift-guard test.
2. **(N1)** Extract one shared `DEFAULT_FILTERS` (still duplicated in `store.ts` +
   `StatsFilterBar.tsx`).
3. **(M1)** Decide the metric grain explicitly — either window everything from
   `tokensByDay`, or document the KPI denominators as whole-session; right now it's mixed.
4. **(M4)** If/when the repo grows a web test target, unit-test `selectors.ts`
   (windowing, faceting, series/heatmap) — it's the highest-value untested code.
5. ✅ **(M5) — DONE (same-machine).** Local-zone bucketing + local session-time display;
   remote-different-TZ remains the documented ~1% limitation.
6. **(L1)** Revisit whole-table reads only if histories reach tens of thousands of files.

---

## Bottom line

This is the work of a careful senior: clean separation, real resilience, strong typing,
good server tests, and honest handling of a genuinely messy data source (qwen's
undifferentiated one-shot calls). **M2 (single-source instructions) and M5 (local-day
windowing + local time display) are now fixed.** The remaining open items are documented
trade-offs and two nits (N1 duplicated `DEFAULT_FILTERS`, M1 mixed metric grain) — not
correctness or safety defects. Address N1 and M1 and it's unambiguously production-grade
for this feature's scope.
