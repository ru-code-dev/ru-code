// ru-code: the ws handlers for the 2 analytics RPCs. Extracted so ws.ts stays a thin
// registration seam: it yields the package scanner, builds the observe wrapper (auth +
// tracing, auth failures encoded into AnalyticsError like the catalog/MCP handlers), and
// spreads `buildAnalyticsRpcHandlers(...)`.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { ANALYTICS_METHODS, type AnalyticsError } from "@smart-tools/qwen-cli-analytics/contracts";
import type { AnalyticsScannerShape } from "@smart-tools/qwen-cli-analytics/server";

/** Per-method auth scopes. Both are reads: getSnapshot returns the stored cache, refresh
 * only rebuilds that server-owned cache from qwen's own transcript files (no mutations
 * outside the feature) — and the panel refreshes automatically on open, so it must work
 * for read-scoped sessions. */
// ru-code: object shape (not tuple array) — matches the shared scope table's shape at
// auth/RpcAuthorization.ts, spread in there (C-app-003; the table moved out of ws.ts on this base).
export const ANALYTICS_RPC_SCOPES = {
  [ANALYTICS_METHODS.analyticsGetSnapshot]: AuthOrchestrationReadScope,
  [ANALYTICS_METHODS.analyticsRefresh]: AuthOrchestrationReadScope,
} as const;

/** Auth+tracing wrapper for one unary analytics RPC (auth failures encoded into AnalyticsError). */
export type ObserveAnalyticsRpc = <A, R>(
  method: string,
  effect: Effect.Effect<A, AnalyticsError, R>,
) => Effect.Effect<A, AnalyticsError, R>;

/**
 * ru-code: entry/exit trace for one analytics RPC.
 *
 * This exists because the failure that started this feature's rework produced **zero server
 * log lines** — indistinguishable from "the request never arrived". `RpcInstrumentation.ts`
 * emits a span and a counter but **no log line at all** (verified: zero `logDebug`/`logError`/
 * `Effect.log` in that file), so this is not duplicate instrumentation. Do not delete it on
 * the grounds that instrumentation already covers it.
 *
 * `Effect.onExit` so the exit branch is recorded for **all three** outcomes — success,
 * failure and interruption. An interrupted RPC (socket closed, panel navigated away) is a
 * normal event here and must not read as a failure.
 *
 * Placement matters as much as existence: apply this OUTSIDE `authorizeEffect`. That helper
 * short-circuits with `Effect.fail` **without running the effect it wraps**, so a trace
 * nested inside it would go silent for exactly the scope-rejected requests where "did it
 * even arrive?" is the question being asked.
 */
export const traceAnalyticsRpc = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.logDebug("[analytics] rpc start", { method }).pipe(
    Effect.andThen(effect),
    Effect.onExit((exit) =>
      Effect.logDebug("[analytics] rpc end", {
        method,
        outcome: Exit.isSuccess(exit)
          ? "success"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure",
      }),
    ),
  );

export function buildAnalyticsRpcHandlers(deps: {
  readonly analyticsScanner: AnalyticsScannerShape;
  readonly observeAnalyticsRpc: ObserveAnalyticsRpc;
}) {
  const { analyticsScanner, observeAnalyticsRpc } = deps;
  return {
    // getSnapshot = pure DB read (instant); refresh = scan disk, re-parse changed
    // transcripts, save, return.
    [ANALYTICS_METHODS.analyticsGetSnapshot]: (_input: object) =>
      observeAnalyticsRpc(ANALYTICS_METHODS.analyticsGetSnapshot, analyticsScanner.getSnapshot()),
    [ANALYTICS_METHODS.analyticsRefresh]: (_input: object) =>
      observeAnalyticsRpc(ANALYTICS_METHODS.analyticsRefresh, analyticsScanner.refresh()),
  };
}
