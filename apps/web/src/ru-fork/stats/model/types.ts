/**
 * ru-fork: Analytics (stats) — domain types.
 *
 * Everything the dashboard renders derives from a single atomic unit, a
 * {@link StatsSession} (one CLI chat). Filters narrow the session set; the
 * selectors aggregate the survivors into the per-widget view models. This is
 * fake/demo data — no server logic — but the shapes mirror what the real
 * on-disk qwen telemetry (`qwen-code.api_response` / `.tool_call` / `.api_error`)
 * would yield, so swapping in a real loader later is a drop-in.
 *
 * @module ru-fork/stats/model/types
 */

export type ProjectKind = "real" | "temp";

export interface TokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly thinking: number;
  readonly cached: number;
}

/** One CLI chat session — the atomic record all widgets aggregate from. */
export interface StatsSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectLabel: string;
  readonly projectPath: string;
  readonly projectKind: ProjectKind;
  readonly branch: string;
  readonly model: string;
  /** ISO timestamp of the session start. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly turns: number;
  readonly isBackground: boolean;
  readonly apiCalls: number;
  readonly tokens: TokenBreakdown;
  readonly avgLatencyMs: number;
  readonly maxLatencyMs: number;
  /** functionName -> call count. */
  readonly toolCounts: Readonly<Record<string, number>>;
  /** functionName -> failed call count (subset of toolCounts). */
  readonly toolFailures: Readonly<Record<string, number>>;
  /** errorType -> count. */
  readonly errorTypes: Readonly<Record<string, number>>;
  readonly autoAccepted: number;
  readonly rejected: number;
}

/** Active dashboard filters (lives in the store). */
export interface StatsFilters {
  readonly rangeDays: RangeDays;
  readonly projectId: string | "all";
  readonly model: string | "all";
  readonly branch: string | "all";
  readonly includeTemp: boolean;
  readonly traffic: TrafficFilter;
}

export type RangeDays = 7 | 14 | 30 | 48;
export type TrafficFilter = "all" | "turns" | "background";
export type Granularity = "day" | "week";

// ── derived view models (selector outputs) ──────────────────────────────────

export interface KpiSet {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cachedTokens: number;
  readonly apiCalls: number;
  readonly toolCalls: number;
  readonly sessions: number;
  readonly projects: number;
  readonly errors: number;
  readonly errorRatePct: number;
  readonly avgLatencyMs: number;
  readonly tokensDeltaPct: number;
}

export interface TimeBucket {
  readonly bucketKey: string;
  readonly label: string;
  readonly input: number;
  readonly output: number;
  readonly thinking: number;
  readonly total: number;
  readonly calls: number;
}

export interface NamedTokenSlice {
  readonly groupKey: string;
  readonly label: string;
  readonly tokens: number;
  readonly sessions: number;
  readonly sharePct: number;
  readonly kind?: ProjectKind | undefined;
}

export interface ToolStat {
  readonly name: string;
  readonly calls: number;
  readonly failures: number;
  readonly successPct: number;
  readonly group: ToolGroup;
}

export type ToolGroup = "fs" | "shell" | "search" | "flow" | "agent" | "mcp" | "web";

export interface ErrorStat {
  readonly type: string;
  readonly count: number;
  readonly sharePct: number;
}

export interface HeatCell {
  readonly weekday: number; // 0=Monday
  readonly hour: number; // 0..23
  readonly tokens: number;
  readonly sessions: number;
}

export interface ApprovalSplit {
  readonly autoAccepted: number;
  readonly rejected: number;
  readonly manual: number;
}

export interface LatencyBucket {
  readonly label: string;
  readonly count: number;
}

/** The fully-aggregated dashboard payload for the current filters. */
export interface StatsView {
  readonly kpis: KpiSet;
  readonly series: readonly TimeBucket[];
  readonly composition: TokenBreakdown;
  readonly byModel: readonly NamedTokenSlice[];
  readonly byProject: readonly NamedTokenSlice[];
  readonly byBranch: readonly NamedTokenSlice[];
  readonly tools: readonly ToolStat[];
  readonly errors: readonly ErrorStat[];
  readonly approvals: ApprovalSplit;
  readonly latency: readonly LatencyBucket[];
  readonly heatmap: readonly HeatCell[];
  readonly sessions: readonly StatsSession[];
}
