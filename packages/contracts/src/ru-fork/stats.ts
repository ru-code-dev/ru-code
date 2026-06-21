// ru-fork: contract for the Stats (Analytics) feature — a per-session view of
// qwen's on-disk usage telemetry (read-only). The server's StatsScanner computes
// one StatsSession per chat file and returns them in a StatsSnapshot; the web
// aggregates them into the dashboard. Kept under ru-fork/ so upstream re-syncs
// never collide. Shapes mirror apps/web/src/ru-fork/stats/model/types.ts so the
// existing UI selectors consume the server data unchanged.
import * as Schema from "effect/Schema";

import { IsoDateTime } from "../baseSchemas.ts";

/** WS method names. Defined here (not in orchestration.ts) to avoid touching upstream. */
// getSnapshot = pure DB read (never scans disk); refresh = scan + parse changed +
// save + return (the only command that touches the transcripts).
export const STATS_GET_SNAPSHOT_METHOD = "stats.getSnapshot" as const;
export const STATS_REFRESH_METHOD = "stats.refresh" as const;

export const StatsProjectKind = Schema.Literals(["real", "temp"]);
export type StatsProjectKind = typeof StatsProjectKind.Type;

/** What a chat file actually is. Only "dialog" is a real interactive conversation;
 *  the rest are one-shot/automatic calls (our text-gen, or qwen-internal). */
export const StatsCategory = Schema.Literals([
  "dialog",
  "title",
  "branch",
  "commit",
  "pr",
  "memory",
  "subagent",
  "compress",
  "service",
]);
export type StatsCategory = typeof StatsCategory.Type;

export const StatsTokenBreakdown = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  thinking: Schema.Number,
  cached: Schema.Number,
});
export type StatsTokenBreakdown = typeof StatsTokenBreakdown.Type;

/** A map "name -> count" carried per session (tool calls, failures, error types). */
export const StatsCountMap = Schema.Record(Schema.String, Schema.Number);
export type StatsCountMap = typeof StatsCountMap.Type;

/** Per-day slice of a session's usage (tokens + api calls that fell on that day). */
export const StatsDayBucket = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  thinking: Schema.Number,
  cached: Schema.Number,
  apiCalls: Schema.Number,
});
export type StatsDayBucket = typeof StatsDayBucket.Type;

/** One CLI chat file, fully reduced to the numbers the dashboard needs. */
export const StatsSession = Schema.Struct({
  sessionId: Schema.String,
  projectId: Schema.String,
  projectLabel: Schema.String,
  projectPath: Schema.String,
  projectKind: StatsProjectKind,
  branch: Schema.String,
  model: Schema.String,
  startedAt: Schema.String, // ISO of the first event
  durationMs: Schema.Number,
  turns: Schema.Number,
  category: StatsCategory,
  isBackground: Schema.Boolean,
  apiCalls: Schema.Number,
  tokens: StatsTokenBreakdown,
  avgLatencyMs: Schema.Number,
  maxLatencyMs: Schema.Number,
  toolCounts: StatsCountMap,
  toolFailures: StatsCountMap,
  errorTypes: StatsCountMap,
  autoAccepted: Schema.Number,
  rejected: Schema.Number,
  /** Usage attributed to the day each event happened (key "YYYY-MM-DD", UTC). */
  tokensByDay: Schema.Record(Schema.String, StatsDayBucket),
  /** Visible tokens per weekday+hour slot (key "weekday:hour", Mon=0, UTC) — heatmap. */
  tokensByWeekdayHour: Schema.Record(Schema.String, Schema.Number),
  /** false ⇒ source file deleted but stats retained. */
  present: Schema.Boolean,
  /** ISO when this file was last seen on disk. */
  lastSeenAt: IsoDateTime,
});
export type StatsSession = typeof StatsSession.Type;

export const StatsSnapshot = Schema.Struct({
  sessions: Schema.Array(StatsSession),
  generatedAt: IsoDateTime,
  scannedFiles: Schema.Number,
  parsedFiles: Schema.Number,
});
export type StatsSnapshot = typeof StatsSnapshot.Type;

export class StatsError extends Schema.TaggedErrorClass<StatsError>()("StatsError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Stats error: ${this.detail}`;
  }
}
