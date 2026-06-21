# Stats (Analytics) — Frontend implementation

Full per-file detail of the web side (`apps/web/src/ru-fork/stats/` + the RPC seam),
generated from the current code. The widgets (KPI strip, charts, sheets) are unchanged
from the original UI; the data layer (rpc, store, hook, selectors, filters) is what wires
them to the live server.

Stack: React + zustand + Recharts (via the basecn `chart` wrapper) + Base UI + Tailwind v4.
All numbers come from the server `StatsSession[]`; the client does the aggregation and
filtering so the dashboard re-renders instantly with no round-trips.

---

## 1. RPC seam — `apps/web/src/rpc/wsRpcClient.ts`

Adds a `stats` namespace to the sole `WsRpcClient` implementation:
```ts
readonly stats: {
  readonly getSnapshot: RpcUnaryMethod<typeof STATS_GET_SNAPSHOT_METHOD>;
  readonly refresh:     RpcUnaryMethod<typeof STATS_REFRESH_METHOD>;
};
// impl:
stats: {
  getSnapshot: (input) => transport.request((c) => c[STATS_GET_SNAPSHOT_METHOD](input)),
  refresh:     (input) => transport.request((c) => c[STATS_REFRESH_METHOD](input)),
},
```
Both are reply RPCs (`transport.request` → `Promise<StatsSnapshot>`), mirroring
`mcp.getSnapshot`. `createWsRpcClient` is the only implementer, so no other file changes.

---

## 2. Domain types — `model/types.ts`

- Re-exports `StatsSession`, `StatsDayBucket`, `StatsCategory` from `@t3tools/contracts`
  (single source of truth; also `import`ed locally so the view types can reference it).
- `CATEGORY_LABEL: Record<StatsCategory, string>` — Russian labels for the «Тип» column
  (Диалог / Заголовок / Ветка / Коммит / PR / Память / Субагент / Сжатие / Служебные).
- `StatsFilters` = `{rangeDays, projectId, model, branch, includeTemp, traffic}`.
- `RangeDays` = `1 | 7 | 14 | 30 | "all"` (calendar-day windows; `"all"` = no cutoff).
- `TrafficFilter` = `"all" | "turns" | "background"`; `Granularity` = `"day" | "week"`.
- View-model types (selector outputs): `KpiSet`, `TimeBucket`, `NamedTokenSlice`,
  `ToolStat`, `ToolGroup`, `ErrorStat`, `HeatCell`, `ApprovalSplit`, `LatencyBucket`,
  and `StatsView` (the full dashboard payload).
- Local `TokenBreakdown` / `ProjectKind` are structurally equal to the contract's.

---

## 3. Reference data — `model/catalog.ts`

Trimmed to a presentation-only tool→group reference: `TOOLS: {name, group}[]` and
`TOOL_GROUP_LABEL`. All *data* comes from the server; this only colours/labels tools and
buckets unknowns. (The old fake-data generator + seeded PRNG were deleted —
`generateSessions.ts`, `fakeData.ts`.)

---

## 4. Filter options — `model/filterOptions.ts` (faceted)

- `RANGE_OPTIONS` = `[{1,Сегодня},{7,7 дней},{14,14 дней},{30,30 дней},{all,Всё время}]`
  (string values; `"all"` is the no-cutoff sentinel).
- `projectOptions(scoped, all, selected)` / `modelOptions(scoped, selected)` /
  `branchOptions(scoped, selected)` — each derives its options from the **scoped**
  session set (sessions that already pass the *other* active filters), prepends the
  `"all"` option, and **always keeps the current selection present** even if it has no
  data in the window (so the control never blanks). Project labels come from
  `projectLabel`; project options sort by label.

The "scoping" is done by the caller (`StatsFilterBar`) — it passes
`filterSessions(sessions, {...filters, <dim>:"all"}, anchorMs)`, i.e. all active filters
with the dropdown's own dimension neutralized. This is true faceted filtering: pick
"Сегодня" and only projects/models/branches with activity today are offered.

---

## 5. Aggregation — `model/selectors.ts` (the heart of the client)

Pure functions; `buildView(allSessions, filters, granularity, anchorMs): StatsView` is
the entry point. Output `StatsView` shape is consumed unchanged by the widgets.

**Time windowing (calendar-day, machine-local):**
- `dayKeyFromMs(ms)` = the **browser-local** "YYYY-MM-DD" (`new Date(ms)` local
  `getFullYear/getMonth/getDate`). Matches the server's local-zone `tokensByDay` keys
  (same machine ⇒ same zone), so "Сегодня" = your real local day.
- `cutoffDayKey(rangeDays, anchorMs)` = earliest in-window day key, or `null` for `"all"`.
- `windowedTokens(session, cutoff)` = sum of the session's `tokensByDay` entries on/after
  the cutoff → `{input,output,thinking,cached,apiCalls}`.
- `hasWindowActivity(session, cutoff)` = any day key ≥ cutoff (or any day, when `"all"`).

**Filtering:** `filterSessions(sessions, filters, anchorMs)` = `matchesDimensions`
(includeTemp / projectId / model / branch) ∧ `matchesTraffic` (turns→!isBackground,
background→isBackground) ∧ `hasWindowActivity`.

**Selectors (all from the filtered set):**
- `buildKpis` — **windowed** token totals + `apiCalls` (summed from in-window days);
  `toolCalls`/`errors` session-grain; `avgLatencyMs` = weighted by whole-session
  `apiCalls`; `tokensDeltaPct` vs `previousWindowVisibleTokens` (the equal-length prior
  window, from `tokensByDay`); `projects` = distinct `projectId`.
- `buildSeries` — usage-over-time; iterates each session's in-window `tokensByDay`,
  bucketed by `day` or `weekStartKey(day)` (Monday-anchored); sorted by key.
- `composition` — `sumWindowedTokens` over the filtered set.
- `groupSlices` — `byModel`/`byProject`/`byBranch`; tokens = **windowed** visible total
  per group, with `sessions` count and `sharePct`; sorted desc by tokens.
- `buildTools`/`buildErrors`/`buildApprovals`/`buildLatency` — **session-grain** over the
  filtered set (no time axis). `toolGroupForName` falls back to `mcp` for `mcp__*` else
  `flow`.
- `buildHeatmap` — from `tokensByWeekdayHour` slots across filtered sessions; parses
  `"weekday:hour"` keys, sums tokens, counts sessions per slot.

**Grain note (intentional):** token/usage metrics are windowed to the in-window days;
tool/error/latency/approval counts are whole-session for any session active in the
window; the heatmap is whole-session (weekday/hour collapses dates). See `audit.md`.

---

## 6. State — `store.ts` (zustand)

`StatsState`: `filters`, `granularity`, `sessions`, `status` (idle/loading/ready/error),
`errorDetail`, `lastRefreshedAtMs`, `refreshNonce`, `openWidget`, `selectedSessionId`.

Actions:
- `setSnapshot(sessions, atMs)` → `{sessions, status:"ready", errorDetail:null,
  lastRefreshedAtMs:atMs}` (used by both the instant read and a successful refresh).
- `setStatus(status, detail?)` → status-only, **never touches `sessions`** → a failed
  refresh keeps the last good data on screen with an error note.
- `requestRefresh()` → bumps `refreshNonce` + sets `loading` (the ⟳ trigger).
- filter/granularity/widget/session setters.

`DEFAULT_FILTERS` = `{rangeDays:30, projectId:"all", model:"all", branch:"all",
includeTemp:false, traffic:"turns"}` — **default traffic = «Диалог»** (only real
conversations shown until you switch to «Фон»/«Все»).

`useStatsView()` memoizes `buildView(sessions, filters, granularity, anchorMs)` where
`anchorMs = lastRefreshedAtMs > 0 ? lastRefreshedAtMs : Date.now()`.

`findSessionById(view, id)` resolves the selected session for the detail sheet.

> Note: `DEFAULT_FILTERS` is duplicated in `StatsFilterBar.tsx` (used there for the
> "reset" comparison + range parse). Flagged in the audit.

---

## 7. Fetch hook — `useStatsData.ts`

Mounted once in `StatsDashboard`. Effect deps `[environmentId, refreshNonce, setSnapshot,
setStatus]`. Resolves the primary environment connection; if absent, no-op.

- `apply(snapshot)` → `setSnapshot(snapshot.sessions, Date.parse(snapshot.generatedAt))`.
- `fail(error)` → `setStatus("error", message)` (keeps data).
- `runRefresh()` → `connection.client.stats.refresh({}).then(apply).catch(fail)`.
- A `refreshNonce` change (vs a `useRef`) means **⟳ was pressed → `refresh` only**.
  Otherwise it's an **open** (mount / primary-env change) → `getSnapshot` (instant read,
  errors ignored) `.finally` → `runRefresh()`.
- `setStatus("loading")` up front; a `cancelled` flag guards async writes after unmount.

**No timer, no reconnect trigger** — data loads only on open and on ⟳.

---

## 8. Components

- **`StatsDashboard.tsx`** — calls `useStatsData()`, reads `useStatsView()` + status;
  renders header + `RefreshControl`, `StatsFilterBar`, `KpiStrip`, an error note
  (`status==="error"`) and a loading note (`loading` && no sessions), then the widget
  grid (`UsageOverTimeCard`, `TokenCompositionCard`, `ModelsCard`, `ProjectsCard`,
  `ToolsCard`, `ReliabilityCard`, `ActivityHeatmapCard`, `SessionsTableCard`) and the two
  drill-down sheets. Layout `max-w-[1400px]`, responsive `lg:grid-cols-4 xl:grid-cols-6`.
- **`StatsFilterBar.tsx`** — a 2-column grid of controls: period / project / model /
  branch `FilterSelect`s (faceted via `useMemo` over `filterSessions` with each
  dimension neutralized), the traffic `Segmented` (Все/Диалог/Фон), and a «Песочница»
  switch (`includeTemp`); a «Сбросить» button appears when filters differ from default.
  `parseRangeDays` maps `"all"`→`"all"` else the numeric range.
- **`RefreshControl.tsx`** — «обновлено N назад» relative-time stamp (`"—"` when never
  refreshed) + the ⟳ button (`requestRefresh()`, spinner while `status==="loading"`).
  No interval/auto-refresh.
- **`primitives.tsx`** — `FilterSelect` (Base UI Select) now passes
  `side="bottom" alignItemWithTrigger={false}` so every dropdown opens **downward**
  (matching every other select in the app, instead of the native align-selected-item
  default that made the period dropdown open upward). Also `WidgetCard`, `DeltaChip`,
  `BarRow`, `Segmented`, chart palette helpers.
- **`widgets/SessionsTableCard.tsx`** — the per-session table; columns Дата · Проект ·
  **Тип** (`CATEGORY_LABEL[session.category]`, badge: secondary for dialog, outline
  otherwise) · Ветка · Токены · Ходы · Инстр. · Длит.; row click → detail sheet;
  error dot when `errorTypes` non-empty.
- **`widgets/ModelsCard.tsx`** — tokens-by-model donut with the legend **stacked below**
  the chart (`flex flex-col items-center`; legend `w-full`); shows the full model id
  (no provider stripping).
- **`components/SessionDetailSheet.tsx`** — single-session drill-down; badges for
  branch, model (full id), sandbox, and the category (`CATEGORY_LABEL`).
- Other widgets (`UsageOverTimeCard`, `TokenCompositionCard`, `ProjectsCard`,
  `ToolsCard`, `ReliabilityCard`, `ActivityHeatmapCard`, `KpiStrip`,
  `WidgetDetailSheet`, `chart.tsx`) are unchanged from the original UI and render the
  corresponding `StatsView` slice.

---

## 9. Removed / deleted

- `model/generateSessions.ts` (seeded PRNG + `DEMO_TODAY`) — deleted.
- `model/fakeData.ts` (fake sessions + static option lists) — deleted.
- All provider-stripping of model ids (`stripModelProvider`, `.replace("qwen/","")`) —
  removed; the full model id is shown verbatim.

---

## 10. Verification

Web has no test target (repo constraint), so the client is validated by
`pnpm typecheck` (14/14) + `pnpm lint` (0/0). The selector logic (the most complex client
code) is therefore **unit-untested** — see `audit.md` for the implication.
