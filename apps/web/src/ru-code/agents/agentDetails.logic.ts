/**
 * ru-code (sub-agents): the model behind the per-agent expander.
 *
 * `foldSubagentActivities` computes 25 fields per agent; the upstream `AgentRow`
 * renders 6 of them and 2 of the 7 usage stats, and the 6-entry `recentActivity`
 * ring has ZERO consumers anywhere under apps/web. None of that is missing data
 * — it is unrendered data. This module decides what the expander shows and in
 * what order; the component owns only the labels (so the localization dictionary
 * can bind them) and the markup.
 *
 * Pure and label-free on purpose: the panel is a port seam, so every decision
 * that can be tested without a DOM is tested without one.
 */
import type { RuntimeSubagent, SubagentUsage } from "@t3tools/client-runtime/state/subagentRuntime";

/** Stable keys the component maps to localized labels. */
export type AgentUsageStatKey =
  | "input"
  | "cached"
  | "output"
  | "reasoning"
  | "toolCalls"
  | "duration";

export interface AgentUsageStat {
  readonly key: AgentUsageStatKey;
  /** Already formatted for display; the component adds only the label. */
  readonly value: string;
}

export interface AgentDetailsModel {
  /** Terminal text, full — the collapsed row can only ever show 180 chars. */
  readonly result: string | null;
  readonly error: string | null;
  /** Newest FIRST — a live line the user just watched belongs at the top. */
  readonly activity: ReadonlyArray<{ readonly at: string; readonly summary: string }>;
  readonly stats: ReadonlyArray<AgentUsageStat>;
  readonly outputFile: string | null;
  /** "run 3" style re-activation count, only when the agent ran more than once. */
  readonly activations: number | null;
}

function formatDurationMs(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The five usage stats the collapsed row throws away (it keeps totalTokens and
 * toolUses) plus toolUses/duration for a complete picture in one place. A stat
 * with no value is omitted rather than rendered as a dash: an empty row costs
 * the reader a lookup and tells them nothing.
 */
export function agentUsageStats(
  usage: SubagentUsage | null,
  formatTokens: (value: number) => string,
): ReadonlyArray<AgentUsageStat> {
  if (!usage) return [];
  const stats: Array<AgentUsageStat> = [];
  const push = (key: AgentUsageStatKey, value: number | undefined) => {
    if (value !== undefined) stats.push({ key, value: formatTokens(value) });
  };
  push("input", usage.inputTokens);
  push("cached", usage.cachedInputTokens);
  push("output", usage.outputTokens);
  push("reasoning", usage.reasoningOutputTokens);
  if (usage.toolUses !== undefined) {
    stats.push({ key: "toolCalls", value: String(usage.toolUses) });
  }
  if (usage.durationMs !== undefined) {
    stats.push({ key: "duration", value: formatDurationMs(usage.durationMs) });
  }
  return stats;
}

export function buildAgentDetailsModel(
  agent: RuntimeSubagent,
  formatTokens: (value: number) => string,
): AgentDetailsModel {
  return {
    result: agent.result,
    error: agent.error,
    activity: agent.recentActivity.toReversed(),
    stats: agentUsageStats(agent.usage, formatTokens),
    outputFile: agent.outputFile,
    activations: agent.activationCount > 1 ? agent.activationCount : null,
  };
}

/**
 * Whether expanding would show anything. The collapsed row already carries the
 * agent's identity and its one activity line, so an agent whose entire state IS
 * that line must not offer an expander that opens onto nothing — and, more
 * importantly, must keep the flat, non-interactive row upstream designed.
 */
export function hasAgentDetails(model: AgentDetailsModel): boolean {
  return (
    model.result !== null ||
    model.error !== null ||
    model.activity.length > 0 ||
    model.stats.length > 0 ||
    model.outputFile !== null ||
    model.activations !== null
  );
}
