/**
 * ru-code: pure readers over a thread's persisted activity history for the
 * compaction machinery. The history is the durable source of truth (same
 * store the chat itself renders from), so everything derived here survives
 * server restarts by construction:
 *
 *   - `deriveThreadCompactionState` — feeds the auto-compact circuit breaker:
 *     the last compaction that reported real numbers, plus the minimum
 *     context-window usage seen SINCE it (the re-arm signal — usage dipping
 *     below the disarm line means compression can help again).
 *   - `findDanglingCompactionTaskIds` / `findDanglingParkedRequests` — feed
 *     the boot sweep: work that was open when the previous server process
 *     died and can never complete (compressions and parked requests do not
 *     survive the process).
 *
 * @module ru-code/qwen/compaction/compactionHistory
 */
import { CONTEXT_COMPACTION_TASK_PREFIX } from "@ru-code/branding";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface QwenCompactionNumbers {
  readonly preTokens: number;
  readonly postTokens: number;
}

export interface QwenThreadCompactionState {
  /** Last compaction `task.completed` carrying real numbers; null ⇒ none yet. */
  readonly lastCompaction: QwenCompactionNumbers | null;
  /** Min `context-window.updated` usedTokens AFTER that row; null ⇒ no sample. */
  readonly minUsedTokensSince: number | null;
}

export interface DanglingParkedRequest {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
}

/**
 * The two columns the dangling derivations actually read. Full
 * `OrchestrationThreadActivity` rows remain assignable; the boot sweep's lean
 * SQL read (kind + extracted taskId/requestId only) produces exactly this.
 */
export interface SweepActivityInput {
  readonly kind: string;
  readonly payload: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asPositiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const compactionTaskId = (activity: SweepActivityInput): string | null => {
  if (activity.kind !== "task.progress" && activity.kind !== "task.completed") return null;
  const taskId = asRecord(activity.payload)?.["taskId"];
  if (typeof taskId !== "string" || !taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX)) return null;
  return taskId;
};

const compactionNumbers = (activity: OrchestrationThreadActivity): QwenCompactionNumbers | null => {
  const usage = asRecord(asRecord(activity.payload)?.["usage"]);
  const preTokens = asPositiveNumber(usage?.["preTokens"]);
  const postTokens = asPositiveNumber(usage?.["postTokens"]);
  return preTokens !== null && postTokens !== null ? { preTokens, postTokens } : null;
};

/**
 * The breaker inputs. Interrupted / swept compactions carry no numbers and are
 * skipped — they never applied (qwen writes its compressed history only at the
 * very end), so they say nothing about whether compressing helps.
 */
export function deriveThreadCompactionState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): QwenThreadCompactionState {
  let lastCompaction: QwenCompactionNumbers | null = null;
  let minUsedTokensSince: number | null = null;

  for (const activity of activities) {
    if (activity.kind === "task.completed" && compactionTaskId(activity) !== null) {
      const numbers = compactionNumbers(activity);
      if (numbers !== null) {
        lastCompaction = numbers;
        minUsedTokensSince = null;
      }
      continue;
    }
    if (lastCompaction !== null && activity.kind === "context-window.updated") {
      const usedTokens = asPositiveNumber(asRecord(activity.payload)?.["usedTokens"]);
      if (usedTokens !== null) {
        minUsedTokensSince =
          minUsedTokensSince === null ? usedTokens : Math.min(minUsedTokensSince, usedTokens);
      }
    }
  }

  return { lastCompaction, minUsedTokensSince };
}

/**
 * The circuit-breaker decision. Disarmed when the last completed compaction
 * left usage at/above the disarm line AND usage has not dipped below it since
 * (a dip means real history piled up again — compressing can help again).
 */
export function isAutoCompactDisarmed(
  state: QwenThreadCompactionState,
  disarmThresholdTokens: number,
): boolean {
  if (state.lastCompaction === null) return false;
  if (state.lastCompaction.postTokens < disarmThresholdTokens) return false;
  return !(state.minUsedTokensSince !== null && state.minUsedTokensSince < disarmThresholdTokens);
}

/** Compaction tasks with a `task.progress` but no `task.completed`. */
export function findDanglingCompactionTaskIds(
  activities: ReadonlyArray<SweepActivityInput>,
): ReadonlyArray<string> {
  const openTaskIds = new Set<string>();
  for (const activity of activities) {
    const taskId = compactionTaskId(activity);
    if (taskId === null) continue;
    if (activity.kind === "task.progress") openTaskIds.add(taskId);
    else openTaskIds.delete(taskId);
  }
  return [...openTaskIds];
}

const PARKED_REQUEST_LIFECYCLE: ReadonlyArray<{
  readonly kind: DanglingParkedRequest["kind"];
  readonly opened: string;
  readonly closed: ReadonlyArray<string>;
}> = [
  {
    kind: "approval",
    opened: "approval.requested",
    closed: ["approval.resolved", "provider.approval.respond.failed"],
  },
  {
    kind: "user-input",
    opened: "user-input.requested",
    closed: ["user-input.resolved", "provider.user-input.respond.failed"],
  },
];

/**
 * Every activity kind the dangling derivations above can react to — the boot
 * sweep's lean SQL filters on exactly this list, so it lives HERE, next to the
 * functions that define it (single source). `compactionTaskId` is kind-gated
 * to the first two entries; the rest are the parked-request open/close pairs.
 */
export const SWEEP_ACTIVITY_KINDS: ReadonlyArray<string> = [
  "task.progress",
  "task.completed",
  ...PARKED_REQUEST_LIFECYCLE.flatMap((lifecycle) => [lifecycle.opened, ...lifecycle.closed]),
];

/**
 * Requests still parked in history (opened, never resolved / never failed a
 * respond). After a server restart these are unanswerable — the held Deferred
 * and the CLI process both died with the previous process.
 */
export function findDanglingParkedRequests(
  activities: ReadonlyArray<SweepActivityInput>,
): ReadonlyArray<DanglingParkedRequest> {
  const open = new Map<string, DanglingParkedRequest>();
  for (const activity of activities) {
    const requestId = asRecord(activity.payload)?.["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0) continue;
    for (const lifecycle of PARKED_REQUEST_LIFECYCLE) {
      if (activity.kind === lifecycle.opened) {
        open.set(requestId, { requestId, kind: lifecycle.kind });
      } else if (lifecycle.closed.includes(activity.kind)) {
        open.delete(requestId);
      }
    }
  }
  return [...open.values()];
}
