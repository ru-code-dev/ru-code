/**
 * ru-fork: Analytics (stats) — public surface.
 *
 * A read-only Settings panel that surfaces usage analytics (tokens, models,
 * tools, reliability, activity) from the server's stats engine, which scans the
 * CLI's per-project chat transcripts. The dashboard fetches one StatsSession per
 * chat file via `stats.getSnapshot` and aggregates them client-side.
 *
 * @module ru-fork/stats
 */
export { StatsDashboard } from "./components/StatsDashboard";
