/**
 * ru-code: hidden context-compaction lifecycle on the web side. The qwen
 * adapter emits the compaction as `task.progress` → `task.completed` under a
 * `CONTEXT_COMPACTION_TASK_PREFIX`-prefixed taskId; these helpers derive from
 * those persisted activities (server-authoritative, survives reload):
 *   - the ONE morphing timeline row (collapse key + warning tone),
 *   - the "compression in progress" flag that blocks send / "Compact context".
 */
import { CONTEXT_COMPACTION_TASK_PREFIX, CONTEXT_COMPACTION_TASK_TYPE } from "@ru-code/branding";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** "Compacting context" — send-button tooltip while a compaction runs. */
export const COMPACTING_CONTEXT_TOOLTIP = "Compacting context";

function compactionTaskId(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
): string | null {
  if (activityKind !== "task.progress" && activityKind !== "task.completed") return null;
  const taskId = payload?.["taskId"];
  if (typeof taskId !== "string" || !taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX)) return null;
  return taskId;
}

/**
 * Collapse key that merges the compaction's progress + completed rows into one
 * morphing row (`collapseDerivedWorkLogEntries` merges consecutive same-key
 * entries). Scoped to compaction taskIds so other providers' task streams
 * (e.g. Claude subagent progress) keep their per-row rendering.
 */
export function compactionCollapseKey(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
): string | undefined {
  const taskId = compactionTaskId(activityKind, payload);
  return taskId === null ? undefined : `task:${taskId}`;
}

/**
 * True for the collapse keys the compaction lifecycle writes (`task:` +
 * prefixed taskId). Rows carrying one are OUR compaction rows — spinner,
 * outcome, interrupt/boot-sweep closures — and must always render: the
 * timeline's neutral-tool filter would otherwise classify the spinner
 * (thinking tone) and the stopped closures as hideable noise.
 */
export function isCompactionCollapseKey(collapseKey: string | undefined): boolean {
  return (
    collapseKey !== undefined && collapseKey.startsWith(`task:${CONTEXT_COMPACTION_TASK_PREFIX}`)
  );
}

/**
 * Whether a work-log entry pair is a compaction's progress row followed by a
 * same-compaction row — the ONE case where consecutive task rows merge into a
 * morphing row. Keys are per-compaction (`task:<taskId>`), so only the pair
 * matches; a terminal row never absorbs a following one.
 */
export function shouldMorphCompactionPair(
  previousActivityKind: string,
  previousCollapseKey: string | undefined,
  nextCollapseKey: string | undefined,
): boolean {
  return (
    previousActivityKind === "task.progress" &&
    previousCollapseKey !== undefined &&
    previousCollapseKey === nextCollapseKey
  );
}

/**
 * True for the compaction lifecycle's OWN task rows (`task.progress` /
 * `task.completed` under a prefixed taskId, or carrying the adapter's
 * `taskType` stamp — both rows carry both, so either identifies the row even
 * if one field is ever dropped upstream).
 *
 * Why it exists: upstream ingestion stamps `title` on every `task.progress`
 * payload, and the timeline's heading prefers `toolTitle` over `label`. On a
 * morphing compaction row that pins the heading to «Идет сжатие контекста…»
 * forever and demotes the outcome to a `- suffix`. Compaction rows REPLACE
 * their text, so they must keep the label as their heading. Scoped strictly
 * to compaction: every other task/tool row keeps its title untouched.
 */
export function isCompactionTaskRow(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
): boolean {
  if (activityKind !== "task.progress" && activityKind !== "task.completed") return false;
  const taskId = payload?.["taskId"];
  if (typeof taskId === "string" && taskId.startsWith(CONTEXT_COMPACTION_TASK_PREFIX)) return true;
  return payload?.["taskType"] === CONTEXT_COMPACTION_TASK_TYPE;
}

/**
 * The adapter marks a near-no-op compaction (circuit-breaker trip) with
 * `payload.tone === "warning"` — activity tones have no "warning", so the
 * override rides the payload (see ProviderRuntimeIngestion's task.completed).
 */
export function isTaskWarningToneRow(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
): boolean {
  return activityKind === "task.completed" && payload?.["tone"] === "warning";
}

/**
 * True while a compaction is running: some compaction `task.progress` has no
 * matching `task.completed` yet. Activities arrive in timeline order, so a
 * plain open-set walk is exact.
 */
export function deriveIsCompactingContext(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  const openTaskIds = new Set<string>();
  for (const activity of activities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = compactionTaskId(activity.kind, payload);
    if (taskId === null) continue;
    if (activity.kind === "task.progress") {
      openTaskIds.add(taskId);
    } else {
      openTaskIds.delete(taskId);
    }
  }
  return openTaskIds.size > 0;
}
