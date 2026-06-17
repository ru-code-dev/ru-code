/**
 * ru-fork: Analytics — pure aggregation. Filters narrow the session set; this
 * turns the survivors into every widget's view model. One source of truth: change
 * a filter and the KPIs, charts, tables and heatmap all recompute from here.
 *
 * @module ru-fork/stats/model/selectors
 */
import { TOOLS } from "./catalog";
import { DEMO_TODAY } from "./generateSessions";
import { dayKey, isoWeekday } from "./format";
import type {
  ApprovalSplit,
  ErrorStat,
  Granularity,
  HeatCell,
  KpiSet,
  LatencyBucket,
  NamedTokenSlice,
  StatsFilters,
  StatsSession,
  StatsView,
  TimeBucket,
  ToolGroup,
  ToolStat,
  TokenBreakdown,
} from "./types";

const MILLISECONDS_PER_DAY = 86_400_000;
const ANCHOR_MS = Date.parse(`${DEMO_TODAY}T23:59:59.000Z`);

const TOOL_GROUP_BY_NAME: ReadonlyMap<string, ToolGroup> = new Map(
  TOOLS.map((tool) => [tool.name, tool.group]),
);
function toolGroupForName(toolName: string): ToolGroup {
  return TOOL_GROUP_BY_NAME.get(toolName) ?? (toolName.startsWith("mcp__") ? "mcp" : "flow");
}

function startsWithinRange(session: StatsSession, rangeDays: number, anchorMs = ANCHOR_MS): boolean {
  const cutoffMs = anchorMs - rangeDays * MILLISECONDS_PER_DAY;
  return Date.parse(session.startedAt) >= cutoffMs;
}

function matchesDimensions(session: StatsSession, filters: StatsFilters): boolean {
  if (!filters.includeTemp && session.projectKind === "temp") return false;
  if (filters.projectId !== "all" && session.projectId !== filters.projectId) return false;
  if (filters.model !== "all" && session.model !== filters.model) return false;
  if (filters.branch !== "all" && session.branch !== filters.branch) return false;
  return true;
}

export function filterSessions(
  sessions: readonly StatsSession[],
  filters: StatsFilters,
): readonly StatsSession[] {
  return sessions.filter((session) => {
    if (!matchesDimensions(session, filters)) return false;
    if (filters.traffic === "turns" && session.isBackground) return false;
    if (filters.traffic === "background" && !session.isBackground) return false;
    return startsWithinRange(session, filters.rangeDays);
  });
}

function sumTokens(sessions: readonly StatsSession[]): TokenBreakdown {
  return sessions.reduce<TokenBreakdown>(
    (accumulator, session) => ({
      input: accumulator.input + session.tokens.input,
      output: accumulator.output + session.tokens.output,
      thinking: accumulator.thinking + session.tokens.thinking,
      cached: accumulator.cached + session.tokens.cached,
    }),
    { input: 0, output: 0, thinking: 0, cached: 0 },
  );
}

function visibleTotal(tokens: TokenBreakdown): number {
  return tokens.input + tokens.output + tokens.thinking;
}

function sumRecordValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value;
  return total;
}

function buildKpis(
  allSessions: readonly StatsSession[],
  filteredSessions: readonly StatsSession[],
  filters: StatsFilters,
): KpiSet {
  const tokens = sumTokens(filteredSessions);
  const apiCalls = filteredSessions.reduce((total, session) => total + session.apiCalls, 0);
  const toolCalls = filteredSessions.reduce((total, session) => total + sumRecordValues(session.toolCounts), 0);
  const errors = filteredSessions.reduce((total, session) => total + sumRecordValues(session.errorTypes), 0);
  const latencyWeighted = filteredSessions.reduce(
    (total, session) => total + session.avgLatencyMs * session.apiCalls,
    0,
  );
  const projectCount = new Set(filteredSessions.map((session) => session.projectId)).size;

  // Previous equal-length window for the trend chips.
  const previousWindowEndMs = ANCHOR_MS - filters.rangeDays * MILLISECONDS_PER_DAY;
  const previousWindowStartMs = previousWindowEndMs - filters.rangeDays * MILLISECONDS_PER_DAY;
  const previousSessions = allSessions.filter((session) => {
    if (!matchesDimensions(session, filters)) return false;
    const startedMs = Date.parse(session.startedAt);
    return startedMs >= previousWindowStartMs && startedMs < previousWindowEndMs;
  });
  const previousTokens = visibleTotal(sumTokens(previousSessions));
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

interface MutableTimeBucket {
  bucketKey: string;
  label: string;
  input: number;
  output: number;
  thinking: number;
  total: number;
  calls: number;
}

function weekStartKey(isoString: string): string {
  const mondayMs = Date.parse(isoString) - isoWeekday(isoString) * MILLISECONDS_PER_DAY;
  return new Date(mondayMs).toISOString().slice(0, 10);
}

function buildSeries(sessions: readonly StatsSession[], granularity: Granularity): readonly TimeBucket[] {
  const bucketsByKey = new Map<string, MutableTimeBucket>();
  for (const session of sessions) {
    const bucketKey = granularity === "day" ? dayKey(session.startedAt) : weekStartKey(session.startedAt);
    const bucket =
      bucketsByKey.get(bucketKey) ??
      { bucketKey, label: bucketKey, input: 0, output: 0, thinking: 0, total: 0, calls: 0 };
    bucket.input += session.tokens.input;
    bucket.output += session.tokens.output;
    bucket.thinking += session.tokens.thinking;
    bucket.total += visibleTotal(session.tokens);
    bucket.calls += session.apiCalls;
    bucketsByKey.set(bucketKey, bucket);
  }
  return Array.from(bucketsByKey.values()).toSorted((first, second) =>
    first.bucketKey.localeCompare(second.bucketKey),
  );
}

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
  describeGroup: (session: StatsSession) => GroupDescriptor,
): readonly NamedTokenSlice[] {
  const slicesByKey = new Map<string, MutableSlice>();
  let grandTotal = 0;
  for (const session of sessions) {
    const descriptor = describeGroup(session);
    const sessionTokens = visibleTotal(session.tokens);
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

interface MutableHeatCell {
  weekday: number;
  hour: number;
  tokens: number;
  sessions: number;
}

function buildHeatmap(sessions: readonly StatsSession[]): readonly HeatCell[] {
  const cellsByKey = new Map<string, MutableHeatCell>();
  for (const session of sessions) {
    const weekday = isoWeekday(session.startedAt);
    const hour = new Date(session.startedAt).getUTCHours();
    const cellKey = `${weekday}:${hour}`;
    const cell = cellsByKey.get(cellKey) ?? { weekday, hour, tokens: 0, sessions: 0 };
    cell.tokens += visibleTotal(session.tokens);
    cell.sessions += 1;
    cellsByKey.set(cellKey, cell);
  }
  return Array.from(cellsByKey.values());
}

export function buildView(
  allSessions: readonly StatsSession[],
  filters: StatsFilters,
  granularity: Granularity,
): StatsView {
  const filteredSessions = filterSessions(allSessions, filters);
  return {
    kpis: buildKpis(allSessions, filteredSessions, filters),
    series: buildSeries(filteredSessions, granularity),
    composition: sumTokens(filteredSessions),
    byModel: groupSlices(filteredSessions, (session) => ({
      groupKey: session.model,
      label: session.model.replace("qwen/", ""),
    })),
    byProject: groupSlices(filteredSessions, (session) => ({
      groupKey: session.projectId,
      label: session.projectLabel,
      kind: session.projectKind,
    })),
    byBranch: groupSlices(filteredSessions, (session) => ({
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
