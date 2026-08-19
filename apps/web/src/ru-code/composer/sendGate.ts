// ru-code: the composer's send-block decision as ONE shared predicate. Every
// send entry point (ChatView.onSend for Enter/form submit, the collapsed
// mobile button) consults the same signals; keeping the decision here means
// a new blocking signal (e.g. the hidden context compaction) cannot be wired
// into one entry point and silently forgotten in another.
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
