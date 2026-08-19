// ru-code: per-thread record of the fingerprints a live provider (`qwen --acp`) session
// spawned with, used to decide whether the next turn must re-spawn.
//
// qwen reads skills and subagents only at spawn. So when either of those effective sets
// changes for an active thread, the live session must re-spawn on the next user message
// (carrying the prior resumeCursor, history preserved). This tracker holds "what did this
// thread's session load", and `changedSources` reports which sources now differ — the
// reactor ORs that into its single restart decision.
//
// The store is source-agnostic: it keys arbitrary source names → fingerprints, so it
// carries exactly the sources handed to it (here: `skills` + `agents`; the port has no
// MCP overlay to track).
//
// WHY A SELF-OWNED STORE (not Effect `Cache`):
//   - Lifetime = session lifetime. The reactor calls `record` on every (re)spawn and
//     `forget` on session stop, so a tracked entry exists iff the session is live. There
//     is no time-based eviction, so an idle-but-healthy session is NEVER force-respawned
//     (the bug a TTL-based cache caused: a 30-min TTL evicts the spawn fingerprint, the
//     next turn sees "no record" → treats it as changed → needless restart every 30 min).
//   - The capacity bound is a pure LEAK BACKSTOP, not the primary bound. It only matters
//     if `forget` is somehow missed for ~`capacity` threads. Eviction policy is therefore
//     OURS and TESTED — least-recently-recorded (FIFO with refresh-on-record) — instead of
//     depending on an unverified Effect `Cache` capacity-eviction policy.
//   - The eviction direction is safe: an evicted entry just reads back as "no record" on
//     the next turn → one harmless respawn → self-heals.

/** What a session spawned with: source name → fingerprint. All values are defined. */
export type SpawnFingerprints = Readonly<Record<string, string>>;

/**
 * The freshly-computed fingerprints for the current turn. A value of `undefined` means
 * "this source could not be fingerprinted this turn" (e.g. a catalog read failed) — such
 * a source is IGNORED: it never counts as a change and is never recorded, so a transient
 * failure can't trigger a spurious respawn nor poison the recorded set.
 */
export type CurrentFingerprints = Readonly<Record<string, string | undefined>>;

export interface SessionFingerprintTracker {
  /**
   * Record what a (re)spawn loaded for `threadId`. MERGES the defined sources into any
   * existing record (a source that failed to compute this spawn keeps its prior value
   * rather than being dropped), and refreshes the entry's recency. Sources with an
   * `undefined` value are skipped. Creating a brand-new entry whose every source is
   * `undefined` is a no-op (nothing to remember).
   */
  readonly record: (threadId: string, fingerprints: CurrentFingerprints) => void;
  /**
   * Which sources differ from what the live session spawned with. A source is "changed"
   * iff its current value is defined AND differs from the recorded one. With NO record for
   * the thread, every defined current source counts as changed — the safe, respawn
   * direction. Sources whose current value is `undefined` are ignored.
   */
  readonly changedSources: (
    threadId: string,
    current: CurrentFingerprints,
  ) => ReadonlyArray<string>;
  /** Drop a thread's record (call on session stop / teardown). Idempotent. */
  readonly forget: (threadId: string) => void;
  /** Introspection: the recorded fingerprints for a thread, or `undefined`. */
  readonly peek: (threadId: string) => SpawnFingerprints | undefined;
  /** Introspection: number of tracked threads. */
  readonly size: () => number;
}

const definedEntries = (current: CurrentFingerprints): ReadonlyArray<readonly [string, string]> =>
  Object.entries(current).filter((entry): entry is [string, string] => entry[1] !== undefined);

export const makeSessionFingerprintTracker = (options?: {
  /** Leak backstop. Eviction (least-recently-recorded first) only fires past this many
   *  tracked threads; with `forget`-on-stop it is effectively never reached. Min 1. */
  readonly capacity?: number;
}): SessionFingerprintTracker => {
  const capacity = Math.max(1, Math.floor(options?.capacity ?? 1000));
  // Insertion-ordered: the FIRST key is the least-recently-recorded (oldest), because
  // `record` deletes+re-sets a refreshed entry, moving it to the end.
  const byThread = new Map<string, SpawnFingerprints>();

  const evictIfOverCapacity = (): void => {
    while (byThread.size > capacity) {
      const oldest = byThread.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      byThread.delete(oldest);
    }
  };

  const record: SessionFingerprintTracker["record"] = (threadId, fingerprints) => {
    const defined = definedEntries(fingerprints);
    const existing = byThread.get(threadId);
    if (existing === undefined && defined.length === 0) {
      return; // nothing to remember for a brand-new thread
    }
    const next: Record<string, string> = { ...existing };
    for (const [source, value] of defined) {
      next[source] = value;
    }
    // Refresh recency: delete then set so the entry moves to the end of the Map.
    byThread.delete(threadId);
    byThread.set(threadId, next);
    evictIfOverCapacity();
  };

  const changedSources: SessionFingerprintTracker["changedSources"] = (threadId, current) => {
    const recorded = byThread.get(threadId);
    const changed: Array<string> = [];
    for (const [source, value] of definedEntries(current)) {
      if (recorded?.[source] !== value) {
        changed.push(source);
      }
    }
    return changed;
  };

  const forget: SessionFingerprintTracker["forget"] = (threadId) => {
    byThread.delete(threadId);
  };

  const peek: SessionFingerprintTracker["peek"] = (threadId) => byThread.get(threadId);

  const size: SessionFingerprintTracker["size"] = () => byThread.size;

  return { record, changedSources, forget, peek, size };
};
