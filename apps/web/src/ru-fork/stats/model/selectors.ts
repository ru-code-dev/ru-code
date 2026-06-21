/**
 * ru-fork: Analytics — pure aggregation. Filters narrow the session set; this turns
 * the survivors into every widget's view model. One source of truth: change a filter
 * and the KPIs, charts, tables and heatmap all recompute from here.
 *
 * Time is handled at the grain the server pre-computed: each session carries
 * `tokensByDay` (per UTC day) and `tokensByWeekdayHour`. Token/usage views are summed
 * from the in-window days, so a multi-day session contributes to each day it touched
 * — no more pinning a whole session to one timestamp.
 *
 * @module ru-fork/stats/model/selectors
 */
import { TOOLS } from "./catalog";
import { isoWeekday } from "./format";
import type {
  ApprovalSplit,
  ErrorStat,
  Granularity,
  HeatCell,
  KpiSet,
  LatencyBucket,
  NamedTokenSlice,
  RangeDays,
  StatsDayBucket,
  StatsFilters,
  StatsSession,
  StatsView,
  TimeBucket,
  ToolGroup,
  ToolStat,
  TokenBreakdown,
} from "./types";

const MILLISECONDS_PER_DAY = 86_400_000;

const TOOL_GROUP_BY_NAME: ReadonlyMap<string, ToolGroup> = new Map(
  TOOLS.map((tool) => [tool.name, tool.group]),
);
function toolGroupForName(toolName: string): ToolGroup {
  return TOOL_GROUP_BY_NAME.get(toolName) ?? (toolName.startsWith("mcp__") ? "mcp" : "flow");
}

// ── time windows (calendar-day aligned, UTC) ────────────────────────────────

/** Local "YYYY-MM-DD" of a millisecond instant — the browser's local day, matching the
 *  server's local-zone day keys (same machine ⇒ same zone). */
function dayKeyFromMs(milliseconds: number): string {
  const date = new Date(milliseconds);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Earliest in-window day key for a range; null ⇒ "all" (no cutoff). */
function cutoffDayKey(rangeDays: RangeDays, anchorMs: number): string | null {
  if (rangeDays === "all") return null;
  return dayKeyFromMs(anchorMs - (rangeDays - 1) * MILLISECONDS_PER_DAY);
}

/** Sum the session's day buckets that fall on/after the cutoff (all if null). */
function windowedTokens(session: StatsSession, cutoff: string | null): StatsDayBucket {
  let input = 0;
  let output = 0;
  let thinking = 0;
  let cached = 0;
  let apiCalls = 0;
  for (const [day, bucket] of Object.entries(session.tokensByDay)) {
    if (cutoff !== null && day < cutoff) continue;
    input += bucket.input;
    output += bucket.output;
    thinking += bucket.thinking;
    cached += bucket.cached;
    apiCalls += bucket.apiCalls;
  }
  return { input, output, thinking, cached, apiCalls };
}

/** Does the session have any activity on/after the cutoff (always, when "all")? */
function hasWindowActivity(session: StatsSession, cutoff: string | null): boolean {
  const days = Object.keys(session.tokensByDay);
  if (cutoff === null) return days.length > 0;
  return days.some((day) => day >= cutoff);
}

function visibleTotal(tokens: TokenBreakdown): number {
  return tokens.input + tokens.output + tokens.thinking;
}

function bucketVisible(bucket: StatsDayBucket): number {
  return bucket.input + bucket.output + bucket.thinking;
}

function sumRecordValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value;
  return total;
}

// ── dimension matching + filtering ──────────────────────────────────────────

function matchesDimensions(session: StatsSession, filters: StatsFilters): boolean {
  if (!filters.includeTemp && session.projectKind === "temp") return false;
  if (filters.projectId !== "all" && session.projectId !== filters.projectId) return false;
  if (filters.model !== "all" && session.model !== filters.model) return false;
  if (filters.branch !== "all" && session.branch !== filters.branch) return false;
  return true;
}

function matchesTraffic(session: StatsSession, filters: StatsFilters): boolean {
  if (filters.traffic === "turns") return !session.isBackground;
  if (filters.traffic === "background") return session.isBackground;
  return true;
}

export function filterSessions(
  sessions: readonly StatsSession[],
  filters: StatsFilters,
  anchorMs: number,
): readonly StatsSession[] {
  const cutoff = cutoffDayKey(filters.rangeDays, anchorMs);
  return sessions.filter(
    (session) =>
      matchesDimensions(session, filters) &&
      matchesTraffic(session, filters) &&
      hasWindowActivity(session, cutoff),
  );
}

// ── token aggregation (windowed) ────────────────────────────────────────────

function sumWindowedTokens(sessions: readonly StatsSession[], cutoff: string | null): TokenBreakdown {
  let input = 0;
  let output = 0;
  let thinking = 0;
  let cached = 0;
  for (const session of sessions) {
    const windowed = windowedTokens(session, cutoff);
    input += windowed.input;
    output += windowed.output;
    thinking += windowed.thinking;
    cached += windowed.cached;
  }
  return { input, output, thinking, cached };
}

/** Visible tokens in the previous equal-length window (for the trend chips). */
function previousWindowVisibleTokens(
  sessions: readonly StatsSession[],
  filters: StatsFilters,
  anchorMs: number,
): number {
  if (filters.rangeDays === "all") return 0;
  const span = filters.rangeDays;
  const previousEnd = dayKeyFromMs(anchorMs - span * MILLISECONDS_PER_DAY);
  const previousStart = dayKeyFromMs(anchorMs - (2 * span - 1) * MILLISECONDS_PER_DAY);
  let total = 0;
  for (const session of sessions) {
    if (!matchesDimensions(session, filters) || !matchesTraffic(session, filters)) continue;
    for (const [day, bucket] of Object.entries(session.tokensByDay)) {
      if (day >= previousStart && day <= previousEnd) total += bucketVisible(bucket);
    }
  }
  return total;
}

function buildKpis(
  allSessions: readonly StatsSession[],
  filteredSessions: readonly StatsSession[],
  filters: StatsFilters,
  anchorMs: number,
  cutoff: string | null,
): KpiSet {
  const tokens = sumWindowedTokens(filteredSessions, cutoff);
  // Counts (calls/tools/errors) + latency are session-grain over the in-window sessions;
  // only token amounts are windowed by day. So errorRate's denominator matches its
  // numerator and the "API calls" tile matches the latency denominator.
  const apiCalls = filteredSessions.reduce((total, session) => total + session.apiCalls, 0);
  const toolCalls = filteredSessions.reduce((total, session) => total + sumRecordValues(session.toolCounts), 0);
  const errors = filteredSessions.reduce((total, session) => total + sumRecordValues(session.errorTypes), 0);
  const latencyWeighted = filteredSessions.reduce(
    (total, session) => total + session.avgLatencyMs * session.apiCalls,
    0,
  );
  const projectCount = new Set(filteredSessions.map((session) => session.projectId)).size;

  const previousTokens = previousWindowVisibleTokens(allSessions, filters, anchorMs);
  const currentTokens = visibleTotal(tokens);
  const tokensDeltaPct = previousTokens > 0 ? ((currentTokens - previousTokens) / previousTokens) * 100 : 0;

  return {
    totalTokens: currentTokens,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    thinkingTokens: tokens.thinking,
    cachedTokens: tokens.cached,
    apiCalls,
    toolCalls,
    sessions: filteredSessions.length,
    projects: projectCount,
    errors,
    errorRatePct: apiCalls > 0 ? (errors / apiCalls) * 100 : 0,
    avgLatencyMs: apiCalls > 0 ? latencyWeighted / apiCalls : 0,
    tokensDeltaPct,
  };
}

// ── usage over time (per day, windowed) ─────────────────────────────────────

interface MutableTimeBucket {
  bucketKey: string;
  label: string;
  input: number;
  output: number;
  thinking: number;
  total: number;
  calls: number;
}

function weekStartKey(dayKeyValue: string): string {
  const mondayMs = Date.parse(`${dayKeyValue}T00:00:00Z`) - isoWeekday(dayKeyValue) * MILLISECONDS_PER_DAY;
  return new Date(mondayMs).toISOString().slice(0, 10);
}

function buildSeries(
  sessions: readonly StatsSession[],
  granularity: Granularity,
  cutoff: string | null,
): readonly TimeBucket[] {
  const bucketsByKey = new Map<string, MutableTimeBucket>();
  for (const session of sessions) {
    for (const [day, dayBucket] of Object.entries(session.tokensByDay)) {
      if (cutoff !== null && day < cutoff) continue;
      const bucketKey = granularity === "day" ? day : weekStartKey(day);
      const bucket =
        bucketsByKey.get(bucketKey) ??
        { bucketKey, label: bucketKey, input: 0, output: 0, thinking: 0, total: 0, calls: 0 };
      bucket.input += dayBucket.input;
      bucket.output += dayBucket.output;
      bucket.thinking += dayBucket.thinking;
      bucket.total += bucketVisible(dayBucket);
      bucket.calls += dayBucket.apiCalls;
      bucketsByKey.set(bucketKey, bucket);
    }
  }
  return Array.from(bucketsByKey.values()).toSorted((first, second) =>
    first.bucketKey.localeCompare(second.bucketKey),
  );
}

// ── dimension leaderboards (windowed tokens per group) ──────────────────────

interface GroupDescriptor {
  readonly groupKey: string;
  readonly label: string;
  readonly kind?: StatsSession["projectKind"] | undefined;
}

interface MutableSlice {
  label: string;
  tokens: number;
  sessions: number;
  kind?: StatsSession["projectKind"] | undefined;
}

function groupSlices(
  sessions: readonly StatsSession[],
  cutoff: string | null,
  describeGroup: (session: StatsSession) => GroupDescriptor,
): readonly NamedTokenSlice[] {
  const slicesByKey = new Map<string, MutableSlice>();
  let grandTotal = 0;
  for (const session of sessions) {
    const descriptor = describeGroup(session);
    const sessionTokens = bucketVisible(windowedTokens(session, cutoff));
    grandTotal += sessionTokens;
    const slice =
      slicesByKey.get(descriptor.groupKey) ??
      { label: descriptor.label, tokens: 0, sessions: 0, kind: descriptor.kind };
    slice.tokens += sessionTokens;
    slice.sessions += 1;
    slicesByKey.set(descriptor.groupKey, slice);
  }
  return Array.from(slicesByKey.entries())
    .map(([groupKey, slice]) => ({
      groupKey,
      label: slice.label,
      tokens: slice.tokens,
      sessions: slice.sessions,
      kind: slice.kind,
      sharePct: grandTotal > 0 ? (slice.tokens / grandTotal) * 100 : 0,
    }))
    .toSorted((first, second) => second.tokens - first.tokens);
}

// ── tools / errors / approvals / latency (session-grain over the filtered set) ──

function buildTools(sessions: readonly StatsSession[]): readonly ToolStat[] {
  const callsByTool = new Map<string, number>();
  const failuresByTool = new Map<string, number>();
  for (const session of sessions) {
    for (const [toolName, callCount] of Object.entries(session.toolCounts)) {
      callsByTool.set(toolName, (callsByTool.get(toolName) ?? 0) + callCount);
    }
    for (const [toolName, failureCount] of Object.entries(session.toolFailures)) {
      failuresByTool.set(toolName, (failuresByTool.get(toolName) ?? 0) + failureCount);
    }
  }
  return Array.from(callsByTool.entries())
    .map(([toolName, calls]) => {
      const failures = failuresByTool.get(toolName) ?? 0;
      return {
        name: toolName,
        calls,
        failures,
        successPct: calls > 0 ? ((calls - failures) / calls) * 100 : 0,
        group: toolGroupForName(toolName),
      };
    })
    .toSorted((first, second) => second.calls - first.calls);
}

function buildErrors(sessions: readonly StatsSession[]): readonly ErrorStat[] {
  const countsByType = new Map<string, number>();
  let totalErrors = 0;
  for (const session of sessions) {
    for (const [errorType, count] of Object.entries(session.errorTypes)) {
      countsByType.set(errorType, (countsByType.get(errorType) ?? 0) + count);
      totalErrors += count;
    }
  }
  return Array.from(countsByType.entries())
    .map(([errorType, count]) => ({
      type: errorType,
      count,
      sharePct: totalErrors > 0 ? (count / totalErrors) * 100 : 0,
    }))
    .toSorted((first, second) => second.count - first.count);
}

function buildApprovals(sessions: readonly StatsSession[]): ApprovalSplit {
  let autoAccepted = 0;
  let rejected = 0;
  let toolCalls = 0;
  for (const session of sessions) {
    autoAccepted += session.autoAccepted;
    rejected += session.rejected;
    toolCalls += sumRecordValues(session.toolCounts);
  }
  return { autoAccepted, rejected, manual: Math.max(0, toolCalls - autoAccepted - rejected) };
}

const LATENCY_BUCKETS: readonly { readonly label: string; readonly maximumMs: number }[] = [
  { label: "<5с", maximumMs: 5_000 },
  { label: "5–10с", maximumMs: 10_000 },
  { label: "10–20с", maximumMs: 20_000 },
  { label: "20–40с", maximumMs: 40_000 },
  { label: "40с+", maximumMs: Number.POSITIVE_INFINITY },
];

function buildLatency(sessions: readonly StatsSession[]): readonly LatencyBucket[] {
  const counts = LATENCY_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  for (const session of sessions) {
    const matchIndex = LATENCY_BUCKETS.findIndex((bucket) => session.avgLatencyMs < bucket.maximumMs);
    const targetIndex = matchIndex === -1 ? LATENCY_BUCKETS.length - 1 : matchIndex;
    const target = counts[targetIndex];
    if (target) target.count += session.apiCalls;
  }
  return counts;
}

// ── activity heatmap (from the per-weekday-hour slots) ──────────────────────

interface MutableHeatCell {
  weekday: number;
  hour: number;
  tokens: number;
  sessions: number;
}

function buildHeatmap(sessions: readonly StatsSession[]): readonly HeatCell[] {
  const cellsByKey = new Map<string, MutableHeatCell>();
  for (const session of sessions) {
    for (const [slot, tokens] of Object.entries(session.tokensByWeekdayHour)) {
      const [weekdayPart, hourPart] = slot.split(":");
      const weekday = Number(weekdayPart);
      const hour = Number(hourPart);
      if (!Number.isInteger(weekday) || !Number.isInteger(hour)) continue;
      const cell = cellsByKey.get(slot) ?? { weekday, hour, tokens: 0, sessions: 0 };
      cell.tokens += tokens;
      cell.sessions += 1;
      cellsByKey.set(slot, cell);
    }
  }
  return Array.from(cellsByKey.values());
}

// ── assembly ────────────────────────────────────────────────────────────────

export function buildView(
  allSessions: readonly StatsSession[],
  filters: StatsFilters,
  granularity: Granularity,
  anchorMs: number,
): StatsView {
  const cutoff = cutoffDayKey(filters.rangeDays, anchorMs);
  const filteredSessions = filterSessions(allSessions, filters, anchorMs);
  return {
    kpis: buildKpis(allSessions, filteredSessions, filters, anchorMs, cutoff),
    series: buildSeries(filteredSessions, granularity, cutoff),
    composition: sumWindowedTokens(filteredSessions, cutoff),
    byModel: groupSlices(filteredSessions, cutoff, (session) => ({
      groupKey: session.model,
      label: session.model,
    })),
    byProject: groupSlices(filteredSessions, cutoff, (session) => ({
      groupKey: session.projectId,
      label: session.projectLabel,
      kind: session.projectKind,
    })),
    byBranch: groupSlices(filteredSessions, cutoff, (session) => ({
      groupKey: session.branch,
      label: session.branch,
    })),
    tools: buildTools(filteredSessions),
    errors: buildErrors(filteredSessions),
    approvals: buildApprovals(filteredSessions),
    latency: buildLatency(filteredSessions),
    heatmap: buildHeatmap(filteredSessions),
    sessions: filteredSessions,
  };
}
