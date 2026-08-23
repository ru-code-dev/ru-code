// ru-code: the composer's send-block decision as ONE shared predicate. Every
// send entry point (ChatView.onSend for Enter/form submit, the collapsed
// mobile button) consults the same signals; keeping the decision here means
// a new blocking signal (e.g. the hidden context compaction) cannot be wired
// into one entry point and silently forgotten in another.
import { QWEN_KIND } from "@ru-code/branding";

export interface ComposerSendGateInput {
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly isCompactingContext: boolean;
  /** Environment unavailable — omitted by callers whose surface hides on it. */
  readonly isEnvironmentUnavailable?: boolean;
  /** Collapsed mobile blocks while a turn streams (its button is Send-only). */
  readonly isRunningTurn?: boolean;
  /** ChatView.onSend: a submit is already in flight (re-entrancy latch). */
  readonly sendInFlight?: boolean;
  /** Button variants: nothing sendable disables the affordance. */
  readonly hasSendableContent?: boolean;
  /** The app has its own stated reason to refuse the send. */
  readonly isSendDisabled?: boolean;
  /** No assistant is available at all. */
  readonly noProviderAvailable?: boolean;
  /** ChatView: the thread's detail is still loading. */
  readonly threadDetailLoading?: boolean;
}

export function shouldBlockComposerSend(input: ComposerSendGateInput): boolean {
  return (
    input.isSendBusy ||
    input.isConnecting ||
    input.isCompactingContext ||
    input.isEnvironmentUnavailable === true ||
    input.isRunningTurn === true ||
    input.sendInFlight === true ||
    input.hasSendableContent === false ||
    input.isSendDisabled === true ||
    input.noProviderAvailable === true ||
    input.threadDetailLoading === true
  );
}

/** Inputs of {@link isQwenRunningTurn}; all of them exist in ChatView already. */
export interface QwenRunningTurnInput {
  /** `activeProviderStatus?.driver` — the driver behind the active thread. */
  readonly providerDriver: string | null | undefined;
  /** `derivePhase(session)` — "running" is the streaming phase. */
  readonly phase: string;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasPendingPlanApproval: boolean;
}

/**
 * ru-code: the qwen-only "a turn is streaming" signal for
 * {@link ComposerSendGateInput.isRunningTurn}.
 *
 * qwen has no steering: a prompt sent during a running turn ABORTS the in-flight
 * one at the CLI, so Enter silently truncates the answer. Every other driver
 * folds a mid-turn send into the running turn (Claude / OpenCode / Cursor / Grok
 * all implement steering), so a blanket rule here would delete a real capability
 * from four providers — hence the driver check, not a bare `phase === "running"`.
 *
 * Parked states are a deliberate exception: while a held approval, a plan
 * approval or a user-input question is open, the session status is still
 * "running" but nothing is streaming, and the send is what settles the parked
 * Deferred server-side. Those keep Enter working.
 */
export function isQwenRunningTurn(input: QwenRunningTurnInput): boolean {
  if (input.providerDriver !== QWEN_KIND) return false;
  if (input.phase !== "running") return false;
  const parkedOnUser =
    input.pendingApprovalCount > 0 ||
    input.pendingUserInputCount > 0 ||
    input.hasPendingPlanApproval;
  return !parkedOnUser;
}
