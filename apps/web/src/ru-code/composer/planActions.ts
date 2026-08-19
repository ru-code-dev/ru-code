// ru-code: pure composer decision helpers shared by ChatView / ChatComposer /
// ComposerPrimaryActions. Extracting the whole state→decision keeps the wired
// behaviour testable as a composite (see MEMORY "test composites not fragments")
// and lets the components stay thin seams that call our code (R6).
import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type { ApprovalRequestId } from "@t3tools/contracts";
import type { SessionPhase } from "../../types";

export type PlanPrimaryActionHandlerKind = "same-thread" | "new-thread";

export interface PlanPrimaryAction {
  label: string;
  handlerKind: PlanPrimaryActionHandlerKind;
}

/**
 * Decides the primary plan-implement button. When the server still holds the
 * exit_plan_mode Deferred (`pendingPlanApprovalRequestId !== null`) the primary
 * action approves in the SAME thread; otherwise it falls back to spawning a new
 * thread (today's port behaviour, and the only path for non-qwen providers,
 * which never surface a `plan_approval` request).
 */
export function selectPlanPrimaryAction(input: {
  pendingPlanApprovalRequestId: ApprovalRequestId | null;
}): PlanPrimaryAction {
  if (input.pendingPlanApprovalRequestId !== null) {
    return { label: "Implement", handlerKind: "same-thread" };
  }
  return { label: "Implement in a new thread", handlerKind: "new-thread" };
}

/**
 * Maps the current runtime mode to the approval decision used when approving a
 * held plan in the same thread. full-access / auto-accept-edits imply the user
 * wants to keep auto-approving, so we accept for the whole session; otherwise a
 * one-shot accept.
 */
export function decisionFromRuntimeMode(runtimeMode: RuntimeMode): ProviderApprovalDecision {
  return runtimeMode === "full-access" || runtimeMode === "auto-accept-edits"
    ? "acceptForSession"
    : "accept";
}

/**
 * M2b: after responding to the held plan approval, the composer flips plan → code
 * so the follow-up turn runs in implement mode. True ONLY when the responded
 * request IS the live plan approval AND the decision approves it (accept /
 * acceptForSession); decline/cancel keep the current mode. Non-qwen providers
 * never surface a `plan_approval`, so `isPlanApprovalRequest` is always false for
 * them ⇒ no effect. This fires on the REAL approve path (the generic approval
 * actions panel), not only the plan follow-up button.
 */
export function shouldSwitchToCodeAfterApproval(input: {
  isPlanApprovalRequest: boolean;
  decision: ProviderApprovalDecision;
}): boolean {
  return (
    input.isPlanApprovalRequest &&
    (input.decision === "accept" || input.decision === "acceptForSession")
  );
}

/**
 * The WHOLE plan→code flip decision ChatView applies after an approval
 * response: the RPC must have succeeded, the responded request must be THE
 * held plan approval (null when none is held — qwen-only today), and the
 * decision must approve. Everything else (other providers, other approval
 * kinds, decline/cancel, failed responses) leaves the composer mode alone.
 */
export function shouldFlipComposerToCodeAfterApprovalResponse(input: {
  responseSucceeded: boolean;
  respondedRequestId: ApprovalRequestId;
  planApprovalRequestId: ApprovalRequestId | null;
  decision: ProviderApprovalDecision;
}): boolean {
  return (
    input.responseSucceeded &&
    shouldSwitchToCodeAfterApproval({
      isPlanApprovalRequest: input.respondedRequestId === input.planApprovalRequestId,
      decision: input.decision,
    })
  );
}

/**
 * Skips the active pending user-input (M8): if a request is parked, dispatches
 * an empty answers payload (`{}`); the server turns that into a cancelled
 * outcome that resumes the turn. No-op when nothing is parked.
 */
export function skipPendingUserInput(input: {
  requestId: ApprovalRequestId | null;
  respond: (requestId: ApprovalRequestId, answers: Record<string, unknown>) => void;
}): void {
  if (input.requestId === null) {
    return;
  }
  input.respond(input.requestId, {});
}

export interface ComposerModeControlsState {
  /** Lock the runtime-mode / plan / interaction controls while a turn streams. */
  modeControlsDisabled: boolean;
  /** Lock the full-access option for providers that forbid it (absent ⇒ allowed). */
  fullAccessDisabled: boolean;
}

/**
 * Derives whether the composer mode controls should be disabled. Gated on
 * `phase === "running"` ONLY — NOT on `isWorking` — so the controls stay live
 * during a connect/checkpoint or an approval pause (the pause is when the user
 * toggles full-access to auto-approve a held plan).
 */
export function deriveComposerModeControlsState(input: {
  phase: SessionPhase;
  allowsFullAccess: boolean;
}): ComposerModeControlsState {
  return {
    modeControlsDisabled: input.phase === "running",
    fullAccessDisabled: input.allowsFullAccess === false,
  };
}
