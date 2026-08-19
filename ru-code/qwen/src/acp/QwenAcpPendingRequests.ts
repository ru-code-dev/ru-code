/**
 * Helper for the two held-Deferred maps that `QwenAdapter` uses to park ACP
 * `session/request_permission` RPCs while it waits for a user reaction:
 *
 *   - `pendingUserInputs` — requests that expect a structured answer
 *     (`ProviderUserInputAnswers`). Today only `ask_user_question`.
 *   - `pendingApprovals` — requests that expect a yes/no `ProviderApprovalDecision`.
 *     The entry's `kind` discriminates `exit_plan_mode` (plan approval) vs the
 *     normalized tool/file approval kinds vs `"unknown"`.
 *
 * `settleAndDelete` resolves the Deferred, deletes the map entry, and logs
 * around it — deleting at resolve-time keeps `.size` in sync the moment the
 * response is committed.
 *
 * NOTE (ru-code): the post-answer-resume probe + continuous wire-stall watchdog
 * from the original implementation are intentionally NOT ported — qwen no longer
 * kills a session on silence; a wedged CLI is recovered by the user's Stop button.
 */

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ApprovalRequestId } from "@t3tools/contracts";

/**
 * Log/discrimination tag. Finer-grained than the adapter's actual map split:
 * `"approval"` and `"plan-approval"` both resolve through `pendingApprovals`,
 * but splitting them in the log tag makes the structured log timeline easier to
 * filter when diagnosing parking issues.
 */
export type AcpPendingKind = "user-input" | "approval" | "plan-approval";

export interface SettleAndDeleteInput<TValue, TEntry> {
  readonly requestId: ApprovalRequestId;
  readonly kind: AcpPendingKind;
  readonly threadId: string;
  readonly map: Map<ApprovalRequestId, TEntry>;
  readonly deferred: Deferred.Deferred<TValue>;
  readonly value: TValue;
  /** Log prefix, e.g. `"qwen-adapter.user-input.respond"`. */
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
