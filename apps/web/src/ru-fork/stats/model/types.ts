/**
 * ru-fork: Analytics (stats) — domain types.
 *
 * Everything the dashboard renders derives from a single atomic unit, a
 * {@link StatsSession} (one CLI chat). Filters narrow the session set; the
 * selectors aggregate the survivors into the per-widget view models. The session
 * shape is owned by the server contract (`@t3tools/contracts`), computed from the
 * on-disk qwen telemetry (`qwen-code.api_response` / `.tool_call` / `.api_error`);
 * the view-model types below are the selectors' derived outputs.
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

// The session shape is owned by the server contract (one row per chat file).
// `tokens` is structurally the web `TokenBreakdown`; the extra `present`/`lastSeenAt`
// fields are ignored by the selectors. The local `ProjectKind` stays structurally
// equal to the contract's "real" | "temp". Imported (not just re-exported) so the
// derived view types below can reference it.
import type { StatsSession } from "@t3tools/contracts";

export type { StatsSession, StatsDayBucket, StatsCategory } from "@t3tools/contracts";

import type { StatsCategory } from "@t3tools/contracts";

/** Russian label for the session «Тип» column. */
export const CATEGORY_LABEL: Record<StatsCategory, string> = {
  dialog: "Диалог",
  title: "Заголовок",
  branch: "Ветка",
  commit: "Коммит",
  pr: "PR",
  memory: "Память",
  subagent: "Субагент",
  compress: "Сжатие",
  service: "Служебные",
};

/** Active dashboard filters (lives in the store). */
export interface StatsFilters {
  readonly rangeDays: RangeDays;
  readonly projectId: string | "all";
  readonly model: string | "all";
  readonly branch: string | "all";
  readonly includeTemp: boolean;
  readonly traffic: TrafficFilter;
}

/** Calendar-day windows. A number N = last N days (incl. today); "all" = no cutoff. */
export type RangeDays = 1 | 7 | 14 | 30 | "all";
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
