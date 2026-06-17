/**
 * ru-fork: Analytics (stats) — public surface.
 *
 * A read-only Settings panel that scans the CLI's per-project chat transcripts
 * and surfaces usage analytics (tokens, models, tools, reliability, activity).
 * Currently driven by fake/demo data — no server logic — but the model shapes
 * mirror the real on-disk qwen telemetry so a real loader is a drop-in later.
 *
 * @module ru-fork/stats
 */
export { StatsDashboard } from "./components/StatsDashboard";
