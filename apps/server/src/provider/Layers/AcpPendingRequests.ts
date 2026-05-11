/**
 * DRY helpers for the two held-Deferred maps that `CliAdapter` uses
 * to park ACP `session/request_permission` RPCs while it waits for a
 * user reaction. All such requests arrive at the wire as tool-calls
 * (each carries `_meta.toolName` plus a `rawInput` shape); the adapter
 * splits them by *response shape* rather than by tool category:
 *
 *   - `pendingUserInputs` — holds requests that expect a structured
 *     answer (`ProviderUserInputAnswers`, a `Record<string, unknown>`).
 *     Today only `ask_user_question` populates this map.
 *
 *   - `pendingApprovals` — holds requests that expect a yes/no-style
 *     `ProviderApprovalDecision`. The entry's `kind` field is the
 *     intra-map discriminator and is one of:
 *       · `"exit_plan_mode"` — plan approval (tool name on the wire
 *         is literally `exit_plan_mode`; the adapter routes it here
 *         before the generic handler because it carries a plan
 *         markdown the UI surfaces specially).
 *       · any string returned by `normalizeToolKind` in
 *         `AcpRuntimeModel.ts` (`"edit"`, `"read"`, `"search"`,
 *         `"fetch"`, …) — generic tool/file approval.
 *       · `"unknown"` — fallback for any tool kind we don't recognize.
 *         Still lands in `pendingApprovals` and gets a real approval
 *         dialog (the web canonicalizes `"unknown"` → `"other"` so the
 *         user sees a generic proceed/cancel prompt rather than the
 *         request being silently dropped).
 *
 * This pass wires only the user-input path; the same helpers will be
 * applied to the plan-approval and tool/file approval paths (both
 * resolved through `pendingApprovals`) in a follow-up DRY mirror. See
 * `instrumental/changes/pending-requests-handling.md`.
 *
 * The helpers expose two operations:
 *
 *   1. `settleAndDelete` — resolve the Deferred, delete the entry
 *      from its map, and log around it. Replaces the inline
 *      `Deferred.succeed(...)` + later `map.delete(...)` pattern that
 *      previously straddled the prompt-Effect's cleanup. Deleting at
 *      resolve-time keeps `pendingApprovals.size` / `.pendingUserInputs.size`
 *      in sync with reality the moment the response is committed.
 *
 *   2. `buildPostAnswerResumeProbe` — returns an Effect that, when
 *      forked by the caller, sleeps `POST_ANSWER_RESUME_TIMEOUT_MS`
 *      and checks `ctx.wireActivity.lastIncomingAt`. If CLI produced
 *      no inbound frame in that window, the probe declares the
 *      session wedged and invokes the caller-supplied `onTimeout`
 *      (typically `abortSession(ctx, MAINTENANCE_METHOD)`).
 *
 *      This is intentionally narrower than the continuous wire-stall
 *      watchdog at `CliAdapter.ts:1029–1069`, which is the wrong
 *      heuristic for models that can think silently for minutes
 *      mid-stream. The resume probe only fires at the specific
 *      transition where CLI MUST respond within milliseconds; once
 *      the first frame arrives, the session is free to think silently.
 *      Probe measurement (`post-answer-resume-gap.mjs`) recorded the
 *      typical resume latency at ~4 ms, so 10 s is ~2500× margin.
 */

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ApprovalRequestId } from "@t3tools/contracts";

/**
 * Log/discrimination tag used by the helpers. Note this is finer-
 * grained than the adapter's actual map split: `"approval"` and
 * `"plan-approval"` both resolve through `pendingApprovals`, but
 * splitting them in the log tag makes the structured log timeline
 * easier to filter when diagnosing parking issues.
 */
export type AcpPendingKind = "user-input" | "approval" | "plan-approval";

/** Subset of the adapter session ctx fields used by the resume probe. */
export interface AcpResumeProbeContext {
  readonly threadId: string;
  readonly wireActivity: { lastIncomingAt: number };
  /** Set by `abortSession()` once the session has been torn down. */
  stopped: boolean;
}

export interface SettleAndDeleteInput<TValue, TEntry> {
  readonly requestId: ApprovalRequestId;
  readonly kind: AcpPendingKind;
  readonly threadId: string;
  readonly map: Map<ApprovalRequestId, TEntry>;
  readonly deferred: Deferred.Deferred<TValue>;
  readonly value: TValue;
  /** Log prefix, e.g. `"cli-adapter.user-input.respond"`. */
  readonly label: string;
}

export const settleAndDelete = <TValue, TEntry>(
  input: SettleAndDeleteInput<TValue, TEntry>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`${input.label}.resolving`, {
      threadId: input.threadId,
      requestId: input.requestId,
      kind: input.kind,
    });
    yield* Deferred.succeed(input.deferred, input.value);
    input.map.delete(input.requestId);
    yield* Effect.logDebug(`${input.label}.settled`, {
      threadId: input.threadId,
      requestId: input.requestId,
      kind: input.kind,
    });
  });

export interface BuildPostAnswerResumeProbeInput {
  readonly ctx: AcpResumeProbeContext;
  readonly requestId: ApprovalRequestId;
  readonly kind: AcpPendingKind;
  readonly timeoutMs: number;
  /** Log prefix, e.g. `"cli-adapter.user-input"`. */
  readonly label: string;
  /**
   * Invoked if the timeout elapses with no inbound frame. Typically
   * `abortSession(ctx, MAINTENANCE_METHOD)`. We don't import
   * `abortSession` here so the helper stays free of adapter-internal
   * symbols.
   */
  readonly onTimeout: Effect.Effect<void>;
}

/**
 * Returns an Effect that the caller forks (via `.pipe(Effect.forkChild)`
 * inside the session scope, matching the existing watchdog pattern at
 * `CliAdapter.ts:998 / 1016 / 1069`). Snapshots `lastIncomingAt` at
 * arm time so we don't need a second timestamp on ctx — any inbound
 * frame after arming advances the timestamp and tells us CLI has
 * resumed.
 */
export const buildPostAnswerResumeProbe = (
  input: BuildPostAnswerResumeProbeInput,
): Effect.Effect<void> => {
  const snapshotAt = input.ctx.wireActivity.lastIncomingAt;
  return Effect.gen(function* () {
    yield* Effect.logDebug(`${input.label}.resume-probe.armed`, {
      threadId: input.ctx.threadId,
      requestId: input.requestId,
      kind: input.kind,
      timeoutMs: input.timeoutMs,
    });
    yield* Effect.sleep(`${input.timeoutMs} millis`);
    if (input.ctx.stopped) {
      yield* Effect.logInfo(`${input.label}.resume-probe.skipped-stopped`, {
        threadId: input.ctx.threadId,
        requestId: input.requestId,
      });
      return;
    }
    if (input.ctx.wireActivity.lastIncomingAt > snapshotAt) {
      yield* Effect.logInfo(`${input.label}.resume-probe.observed`, {
        threadId: input.ctx.threadId,
        requestId: input.requestId,
      });
      return;
    }
    yield* Effect.logError(`${input.label}.resume-probe.fired`, {
      threadId: input.ctx.threadId,
      requestId: input.requestId,
      kind: input.kind,
      timeoutMs: input.timeoutMs,
    });
    yield* input.onTimeout;
  });
};
