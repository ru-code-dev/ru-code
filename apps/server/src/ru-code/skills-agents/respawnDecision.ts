// ru-code: the pure predicate the ProviderCommandReactor uses to decide whether a LIVE provider
// session (e.g. qwen --acp) must be re-spawned on the next turn instead of resumed in place.
//
// It is extracted here so the decision is unit-testable in isolation (the reactor itself is a large
// stateful effect). The reactor computes the individual change flags and calls this; a session
// restarts iff ANY flag is set. `catalogChanged` is our dimension: qwen reads its skills + subagents
// only at spawn, so ANY change to the effective skill/agent set of the thread's project — a global
// add/remove, a per-project connect/disconnect, or a sync that rewrites the files — must force a
// respawn (the change is detected by the SessionRespawnGate). Keeping this a single OR means a future
// edit that drops `catalogChanged` from the set is caught by the test.
export interface ProviderRestartFlags {
  /** The thread's runtime mode (e.g. full-access) differs from the live session's. */
  readonly runtimeModeChanged: boolean;
  /** The resolved working directory differs from the live session's. */
  readonly cwdChanged: boolean;
  /** The requested provider instance differs from the live session's. */
  readonly instanceChanged: boolean;
  /** A model change the provider cannot switch in place. */
  readonly shouldRestartForModelChange: boolean;
  /** A provider-specific model-selection change that requires a restart. */
  readonly shouldRestartForModelSelectionChange: boolean;
  /** ru-code: the effective skill/agent set changed vs. what the live session spawned with. */
  readonly catalogChanged: boolean;
}

/** True ⇒ tear down and re-spawn the provider session this turn; false ⇒ keep resuming it. */
export const shouldRestartProviderSession = (flags: ProviderRestartFlags): boolean =>
  flags.runtimeModeChanged ||
  flags.cwdChanged ||
  flags.instanceChanged ||
  flags.shouldRestartForModelChange ||
  flags.shouldRestartForModelSelectionChange ||
  flags.catalogChanged;
