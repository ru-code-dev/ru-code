// ru-code (agentic-flow wave, P3b): the poll's SNAPSHOT→DELTA translation.
//
// Pure and synchronous on purpose. `qwen/status/session/tasks` answers a
// full-state snapshot (research §2.3), while every consumer downstream — the
// contract's `task.*` events, `foldSubagentActivities`'s `activationCount += 1`
// and append-only `recentActivity` (subagentRuntime.ts:527+) — is
// incremental-by-construction. Nothing in this codebase has ever ingested a
// snapshot for any provider (bg-agents-our-side-readiness §7.2), so the
// translation is genuinely new; keeping it a pure function is what makes it
// testable without a clock, a fiber or a fake child.
//
// The adapter owns the effects (stamping and emitting); this module owns the
// decisions.
//
// Pins are at qwen v0.21.1 = 41b4ee8373fb4aa324925e69e0515ca72959ec5b.
import type { RuntimeTaskStatus, RuntimeTaskUsage } from "@t3tools/contracts";

import {
  isQwenTaskTerminal,
  type QwenAgentTaskSnapshot,
  type QwenAgentTaskLifecycleStatus,
} from "./backgroundTaskContract.ts";

/**
 * Poll cadence. Mirrors the ONE existing periodic reader in this fork — the
 * transcript tailer's `pollIntervalSeconds ?? 1`
 * (ru-code-packages/…/qwen-cli-transcript-core/src/tail.ts:209-211) — rather
 * than inventing a number: a second is already the house answer to "how often
 * do we look at a qwen-side artifact that has no push channel".
 */
export const QWEN_BACKGROUND_POLL_INTERVAL_MS = 1_000;

/**
 * Consecutive transport failures before the poll gives up on a session.
 *
 * Three, matching qwen's OWN rule for the mirror-image situation: its mid-turn
 * drain latches off after three consecutive failures and IMMEDIATELY on a
 * method-not-found (Session.ts:4756/:4776-4783, transcribed in
 * `qwen021MidTurnDrain.ts`). We are the caller here rather than the callee, but
 * the question — "is this channel real, or am I talking to an engine that does
 * not have it" — is identical, and answering it two different ways in one
 * adapter would be the invention, not the reuse.
 */
export const QWEN_BACKGROUND_POLL_MAX_STRIKES = 3;

/** JSON-RPC "method not found" — a 0.13.1 engine has no background feature. */
const METHOD_NOT_FOUND = -32601;

/**
 * Is this failure PERMANENT for the session? A missing method can never start
 * existing mid-session, so retrying it is pure noise; anything else (a transient
 * transport hiccup, a busy child) gets its three strikes.
 */
export const isQwenPollPermanentFailure = (input: {
  readonly errorCode?: number | undefined;
  readonly errorMessage?: string | undefined;
}): boolean =>
  input.errorCode === METHOD_NOT_FOUND ||
  (input.errorMessage ?? "").toLowerCase().includes("method not found");

/**
 * qwen's lifecycle vocabulary → the contract's shared one.
 *
 * `paused` → `idle` is NOT a new mapping: `ClaudeAdapter.ts:993` already maps
 * its provider's `paused` to `idle`, and the whole client stack is built around
 * that meaning — `applyStatus` treats idle as reactivatable
 * (subagentRuntime.ts:483), the panel labels it "Idle · resumable"
 * (AgentsPanel.tsx STATUS_VISUALS) and the roster sorts it between active and
 * settled (:750). A qwen task rehydrated as `paused` (research §15.1) is
 * exactly that: settled-looking, resumable, still worth showing.
 *
 * ru-code (agentic-flow wave, FIX ROUND 1): both line pins corrected from
 * `:470`/`:737` — stale by +13 (verifier F5). The claims hold at the new lines.
 */
const LIVE_STATUS: ReadonlyMap<QwenAgentTaskLifecycleStatus, RuntimeTaskStatus> = new Map([
  ["running", "running"],
  ["paused", "idle"],
]);

/** qwen's terminal vocabulary → `TaskCompletedPayload.status`. */
const TERMINAL_STATUS: ReadonlyMap<
  QwenAgentTaskLifecycleStatus,
  "completed" | "failed" | "stopped"
> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  // A cancel is a STOP, not a failure — the same reading
  // `QwenAcpSubAgents.ts`'s TERMINAL_AGENT_STATUS already takes.
  ["cancelled", "stopped"],
]);

/** What we remember about one task between ticks. */
export interface QwenTrackedTask {
  readonly status: QwenAgentTaskLifecycleStatus;
  /** Fingerprint of the last progress row emitted, so a still tick emits nothing. */
  readonly progressKey: string;
  /** True once a terminal row has been emitted for this task. */
  readonly settled: boolean;
}

/** One thing the adapter should emit for one task. */
export type QwenBackgroundDelta =
  | {
      readonly _tag: "BackgroundProgress";
      readonly taskId: string;
      readonly description: string;
      readonly status: RuntimeTaskStatus;
      readonly role?: string;
      readonly toolUseId?: string;
      readonly summary?: string;
      readonly lastToolName?: string;
      readonly typedUsage?: RuntimeTaskUsage;
      readonly error?: string;
    }
  | {
      readonly _tag: "BackgroundTerminal";
      readonly taskId: string;
      readonly status: "completed" | "failed" | "stopped";
      /**
       * qwen's OWN display label for this task (`buildBackgroundEntryLabel`,
       * tasksSnapshot.ts:47) and its OWN lifecycle word. Carried so the chat
       * fallback can rebuild qwen's own completion sentence
       * (`background-tasks.ts:1556-1564`) rather than inventing one.
       */
      readonly label: string;
      readonly lifecycleStatus: QwenAgentTaskLifecycleStatus;
      readonly title?: string;
      readonly role?: string;
      readonly toolUseId?: string;
      readonly summary?: string;
      readonly detail?: string;
      readonly typedUsage?: RuntimeTaskUsage;
    };

export interface QwenBackgroundDiff {
  readonly deltas: ReadonlyArray<QwenBackgroundDelta>;
  readonly next: ReadonlyMap<string, QwenTrackedTask>;
  /** True when nothing non-terminal is left to watch — the poll may stop. */
  readonly allTerminal: boolean;
}

/**
 * `AgentCompletionStats` → `RuntimeTaskUsage`. `totalTokens` is required by the
 * contract, so a snapshot without it yields NO usage rather than a half-filled
 * record — the same rule `agentUsageFromRawOutput` already applies to the
 * foreground path.
 */
const usageFromStats = (snapshot: QwenAgentTaskSnapshot): RuntimeTaskUsage | undefined => {
  const stats = snapshot.stats;
  if (stats === undefined || stats.totalTokens === undefined) return undefined;
  return {
    totalTokens: stats.totalTokens,
    ...(stats.outputTokens !== undefined ? { outputTokens: stats.outputTokens } : {}),
    ...(stats.toolUses !== undefined ? { toolUses: stats.toolUses } : {}),
    ...(stats.durationMs !== undefined ? { durationMs: stats.durationMs } : {}),
  };
};

/**
 * The newest entry of qwen's own `recentActivities` ring (tasksSnapshot.ts:64-72).
 * It is the ONLY live progress data the wire carries (research §2.3): the tool's
 * name at invocation time, plus its description. The outcome is deliberately
 * absent upstream (research §13.5), so the row shows what was attempted — never
 * a result we do not have.
 */
const newestActivity = (snapshot: QwenAgentTaskSnapshot) => {
  const activities = snapshot.recentActivities;
  if (activities === undefined || activities.length === 0) return undefined;
  return activities.reduce((newest, entry) => (entry.at >= newest.at ? entry : newest));
};

/**
 * The fingerprint that decides whether a tick is worth an event at all.
 *
 * Without it every tick would re-emit an identical progress row, and the fold
 * appends each one to `recentActivity` — a one-second heartbeat would fill the
 * ring with copies of the same line and cost an ingestion upsert per second per
 * task. Composed of exactly the fields a progress row renders.
 */
const progressFingerprint = (snapshot: QwenAgentTaskSnapshot): string => {
  const activity = newestActivity(snapshot);
  const stats = snapshot.stats;
  return [
    snapshot.status,
    activity?.name ?? "",
    activity?.at ?? "",
    stats?.totalTokens ?? "",
    stats?.toolUses ?? "",
    snapshot.error ?? "",
  ].join("|");
};

const progressDelta = (snapshot: QwenAgentTaskSnapshot): QwenBackgroundDelta | undefined => {
  const status = LIVE_STATUS.get(snapshot.status);
  if (status === undefined) return undefined;
  const activity = newestActivity(snapshot);
  const typedUsage = usageFromStats(snapshot);
  // `▸ name · description` — the same one-line shape the foreground path's
  // inner-tool line uses, so a background row reads identically to a live one.
  const summary =
    activity === undefined
      ? undefined
      : activity.description.length > 0
        ? `▸ ${activity.name} · ${activity.description}`
        : `▸ ${activity.name}`;
  return {
    _tag: "BackgroundProgress",
    taskId: snapshot.id,
    description: snapshot.description,
    status,
    ...(snapshot.subagentType !== undefined ? { role: snapshot.subagentType } : {}),
    ...(snapshot.toolUseId !== undefined ? { toolUseId: snapshot.toolUseId } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(activity !== undefined ? { lastToolName: activity.name } : {}),
    ...(typedUsage !== undefined ? { typedUsage } : {}),
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
  };
};

const settledDelta = (snapshot: QwenAgentTaskSnapshot): QwenBackgroundDelta | undefined => {
  const status = TERMINAL_STATUS.get(snapshot.status);
  if (status === undefined) return undefined;
  const typedUsage = usageFromStats(snapshot);
  return {
    _tag: "BackgroundTerminal",
    taskId: snapshot.id,
    status,
    label: snapshot.label,
    lifecycleStatus: snapshot.status,
    ...(snapshot.description.length > 0 ? { title: snapshot.description } : {}),
    ...(snapshot.subagentType !== undefined ? { role: snapshot.subagentType } : {}),
    ...(snapshot.toolUseId !== undefined ? { toolUseId: snapshot.toolUseId } : {}),
    // qwen's own words for a failure; a success carries no result on this
    // surface at all (`ServeSessionAgentTaskStatus` has no `result` field,
    // status.ts:611-644), so nothing is invented to fill the gap.
    ...(snapshot.error !== undefined ? { summary: snapshot.error } : {}),
    ...(snapshot.resumeBlockedReason !== undefined ? { detail: snapshot.resumeBlockedReason } : {}),
    ...(typedUsage !== undefined ? { typedUsage } : {}),
  };
};

/**
 * Diff one poll answer against what we already published.
 *
 * `tracked` carries the tasks we are watching; a task in the snapshot that we
 * are NOT tracking is ignored — the roster is opened by the launch classifier
 * (P3a) and by the post-load probe, so a snapshot row we never saw launched
 * belongs to some other producer (a shell, a monitor, an agent from a previous
 * incarnation of this session) and inventing a row for it would put work on the
 * panel that this thread never started.
 *
 * A tracked task ABSENT from the snapshot yields nothing at all. That is not
 * defensive vagueness: `MAX_RETAINED_TERMINAL_AGENTS = 32` evicts already-
 * notified terminal entries (background-tasks.ts:1661-1676), so disappearing
 * after a terminal is qwen's normal behaviour, and a running/paused entry is
 * NEVER evicted (:142-145) — so absence can never mean "it died quietly".
 */
export const diffQwenBackgroundTasks = (
  tracked: ReadonlyMap<string, QwenTrackedTask>,
  snapshot: ReadonlyArray<QwenAgentTaskSnapshot>,
): QwenBackgroundDiff => {
  const deltas: QwenBackgroundDelta[] = [];
  const next = new Map(tracked);
  const seen = new Set<string>();

  for (const row of snapshot) {
    const previous = tracked.get(row.id);
    if (previous === undefined) continue;
    seen.add(row.id);
    if (previous.settled) continue;

    if (isQwenTaskTerminal(row.status)) {
      const delta = settledDelta(row);
      if (delta !== undefined) deltas.push(delta);
      next.set(row.id, { status: row.status, progressKey: previous.progressKey, settled: true });
      continue;
    }

    const key = progressFingerprint(row);
    if (key === previous.progressKey) continue;
    const delta = progressDelta(row);
    if (delta !== undefined) deltas.push(delta);
    next.set(row.id, { status: row.status, progressKey: key, settled: false });
  }

  // Absent-and-unsettled tasks stay tracked (they cannot have been evicted, per
  // the doc above) so a later snapshot still reconciles them by id — ids are
  // immutable across crash → paused → resumed (research §15.3), which is what
  // makes merge-by-id safe in the first place.
  const allTerminal = [...next.values()].every((entry) => entry.settled);
  return { deltas, next, allTerminal };
};

/** Seed an entry for a task we just learned about from a launch or a probe. */
export const trackQwenBackgroundTask = (
  tracked: Map<string, QwenTrackedTask>,
  taskId: string,
): void => {
  if (tracked.has(taskId)) return;
  tracked.set(taskId, { status: "running", progressKey: "", settled: false });
};
