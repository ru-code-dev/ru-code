// ru-code (agentic-flow wave): the SHARED wire contract for qwen's
// background-agent surface — the bytes production and the test transcription
// must agree on exactly, plus the decoders that turn qwen's untyped ext-method
// answers into something typed.
//
// DRY note, mirroring `midturn/midTurnDrainContract.ts`: the 1:1 transcription
// of qwen's own PRODUCERS (the launch prose, the snapshot serializer, the
// pseudo-turn frames, the 32-cap eviction) lives in the test tree at
// `tests/qwen/fake-acp/qwen021BackgroundAgents.ts`, because it models the
// AGENT's behaviour and only the fake needs it. Everything BOTH sides need is
// defined here once and imported there — a method name, a cap or a status
// vocabulary that disagreed between the poller and the fake would make the whole
// matrix vacuous.
//
// Pins are at qwen v0.21.1 = 41b4ee8373fb4aa324925e69e0515ca72959ec5b:
//   status.ts        = packages/acp-bridge/src/status.ts
//   tasksSnapshot.ts = packages/cli/src/acp-integration/session/tasksSnapshot.ts
//   acpAgent.ts      = packages/cli/src/acp-integration/acpAgent.ts
//   agent.ts         = packages/core/src/tools/agent/agent.ts
//   Session.ts       = packages/cli/src/acp-integration/session/Session.ts
//   background-tasks.ts = packages/core/src/agents/background-tasks.ts
import * as Schema from "effect/Schema";

/** status.ts:110 — `SERVE_STATUS_EXT_METHODS.sessionTasks`. */
export const QWEN_SESSION_TASKS_METHOD = "qwen/status/session/tasks";

/** status.ts:160 — `SERVE_CONTROL_EXT_METHODS.sessionTaskCancel`. */
export const QWEN_SESSION_TASK_CANCEL_METHOD = "qwen/control/session/task/cancel";

/** status.ts:11 — `STATUS_SCHEMA_VERSION`. Echoed as `v` on every answer. */
export const QWEN_STATUS_SCHEMA_VERSION = 1;

/** Session.ts:6078 — the pseudo-turn's nonstandard end-of-turn extNotification. */
export const QWEN_BACKGROUND_END_TURN_METHOD = "_qwencode/end_turn";

/**
 * Its params — exactly three, no usage payload (Session.ts:6078-6082).
 * `reason` and `source` are optional here only so a fork that drops one still
 * delivers the signal; qwen itself always sends all three.
 */
export const QwenBackgroundEndTurnParams = Schema.Struct({
  sessionId: Schema.String,
  reason: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});

/**
 * background-tasks.ts:147 — `MAX_RETAINED_TERMINAL_AGENTS`.
 *
 * Only ALREADY-NOTIFIED terminal entries are evictable (:1663); running, paused
 * and not-yet-notified entries are never dropped (:142-145). Consequence the
 * poller must honour: a task VANISHING from the snapshot after we have seen it
 * terminal is NORMAL, not a lost task — the row keeps whatever terminal we
 * already recorded.
 */
export const QWEN_MAX_RETAINED_TERMINAL_AGENTS = 32;

/**
 * status.ts:598-603 — `ServeSessionTaskLifecycleStatus`. The complete union; no
 * `pending`/`queued`/`awaiting_approval` value exists (research §16.1).
 */
export type QwenAgentTaskLifecycleStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The statuses that end a task's life FOR THE POLLER. `paused` is deliberately
 * NOT terminal: a rehydrated crash survivor sits there indefinitely and is
 * resumable by the model (research §15.2), so a poll that stopped on it would
 * blind the row to its own resume.
 */
const TERMINAL_STATUSES: ReadonlySet<QwenAgentTaskLifecycleStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const isQwenTaskTerminal = (status: QwenAgentTaskLifecycleStatus): boolean =>
  TERMINAL_STATUSES.has(status);

/**
 * agent.ts:3677 — the ONE line of the launch payload that carries the task id.
 *
 * `task_id: ${hookOpts.agentId} (internal ID — do not mention to the user. …)`
 *
 * Anchored on both ends of qwen's own template: the `task_id: ` prefix at the
 * start of a line, and the ` (` that opens the parenthetical. Lazy in between,
 * so the id ends at the FIRST ` (` — which is where qwen's interpolation ends.
 */
const QWEN_LAUNCH_TASK_ID_PATTERN = /(?:^|\n)task_id: (\S[^\n]*?) \(/u;

/**
 * ru-code (agentic-flow wave, FIX ROUND 1): THE RULED OPTION A EXTRACTION
 * (RULINGS 2026-08-27 — "F1 RULED = OPTION A").
 *
 * The task id is READ from the launch payload's fixed `task_id: <id> (` line
 * and never reconstructed. The superseded rule —
 * `` `${subagentName}-${toolCallId}` `` — is DISPROVEN at the qwen source:
 *
 *   · `agent.ts:2839` `const agentIdSuffix = this.callId ?? randomUUID().slice(0, 8);`
 *     and `:2842` `agentId: \`${subagentConfig.name}-${agentIdSuffix}\``;
 *   · `this.callId` (`agent.ts:1302`, undefined at construction) is written ONLY
 *     by `setCallId` (`:1313-1315`);
 *   · the ACP path executes tools in `Session.runTool` — qwen says so itself at
 *     `Session.ts:7353` ("duplicated from coreToolScheduler.ts; ACP routes
 *     through this Session path") — and that function's only `setCallId` call is
 *     `Session.ts:7181-7185`, gated `if (policyToolName === ToolNames.MONITOR)`.
 *     `tool-names.ts:30` (`AGENT: 'agent'`) and `:55` (`MONITOR: 'monitor'`) are
 *     distinct constants, so the Agent tool never enters it; `Session.ts:7149`'s
 *     `isAgentTool` only wires an abort controller (`:7154-7167`);
 *   · `coreToolScheduler.ts:1867-1869` calls it unconditionally, but that is the
 *     non-ACP scheduler, never instantiated from `Session.ts` (`:7121` is a
 *     comment reference only).
 *
 * So on the ACP path the suffix is ALWAYS `randomUUID().slice(0, 8)` — a value
 * that appears NOWHERE on the wire in structured form (`AgentResultDisplay` has
 * no id field at all, tools.ts:630-658; the launch frame's `_meta` carries none
 * either, research §9.3). The prose line is the only channel that exists.
 *
 * Owner live smoke against real qwen 0.21.1 confirmed the consequence: rows
 * keyed by the reconstruction froze at "Working" because every poll snapshot,
 * notification `_meta.backgroundTask.taskId` and cancel call spoke the real id.
 *
 * This is machine-written text, not model prose: ONE template literal at ONE
 * site (agent.ts:3676-3682, verified the only `task_id: <value> (` producer in
 * qwen at v0.21.1), emitted by code with no branch. Returning `undefined` on a
 * miss is deliberate — the caller's guard then opens NO row, which is a visible
 * failure rather than a card that can never be updated.
 */
export const readQwenLaunchTaskId = (launchText: string | undefined): string | undefined => {
  if (launchText === undefined) return undefined;
  const id = QWEN_LAUNCH_TASK_ID_PATTERN.exec(launchText)?.[1]?.trim();
  return id !== undefined && id.length > 0 ? id : undefined;
};

/**
 * ru-code (agentic-flow wave, live-issues T3): THE RESUME RESULT LINE.
 *
 * Same extraction class as `readQwenLaunchTaskId`, and ratified on the same
 * grounds (RULINGS 2026-08-27 F1 = OPTION A): on this wire the task id exists
 * ONLY inside qwen's own machine-written result sentence. `send_message` has
 * exactly three SUCCESS shapes and they share one interpolation
 * (`send-message.ts`, v0.21.1):
 *   · a PAUSED task    → `Background task "<id>" resumed with your message as
 *     the first continuation instruction.` (`:137-140`)
 *   · a RESIDENT completed task → `Background task "<id>" continued on its
 *     existing runtime with your message as the next instruction.` (`:154-157`)
 *   · a REVIVED completed task  → `Background task "<id>" had completed;
 *     revived it with your message as the next instruction.` (`:175-178`)
 *
 * Every FAILURE shape opens `Error: ` and none of them carries one of the three
 * verbs (`cannot be continued`, `could not be resumed`, `could not be revived`,
 * `is not running`), so the verb alternation excludes them twice over — once by
 * the line anchor, once by the verb. That matters: a failed send resumes
 * nothing, and re-arming the poll for it would be a lie about live work.
 *
 * WHY THE RESULT FRAME AND NOT THE CALL: it is the only point that is
 * RACE-FREE BY CONSTRUCTION. All three success paths flip the registry entry to
 * `'running'` synchronously BEFORE `execute()` returns — the resident path via
 * `residentController.continue` → `registry.restartCompletedAgent(...)` and its
 * own `restarted.status !== 'running'` refusal (agent.ts:3597-3625), the revive
 * path with qwen's own comment "the status flip below is await-free"
 * (background-agent-resume.ts:642), and the paused path per research §15.4. So a
 * poll tick armed by this frame is guaranteed to observe the flip, exactly as
 * the post-load probe is guaranteed to observe rehydration (RULINGS 2026-08-27).
 */
const QWEN_RESUME_RESULT_PATTERN =
  /(?:^|\n)Background task "([^"\n]+)" (?:resumed with|continued on|had completed; revived)/u;

export const readQwenResumedTaskId = (resultText: string | undefined): string | undefined => {
  if (resultText === undefined) return undefined;
  const id = QWEN_RESUME_RESULT_PATTERN.exec(resultText)?.[1]?.trim();
  return id !== undefined && id.length > 0 ? id : undefined;
};

/** `AgentCompletionStats` — background-tasks.ts:209-214. */
export interface QwenTaskStatsSnapshot {
  readonly totalTokens?: number;
  readonly outputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

/**
 * One decoded `ServeSessionAgentTaskStatus` (status.ts:611-644). Only the fields
 * this wave consumes are surfaced; everything else is dropped at the decoder so
 * an unread field cannot silently become a dependency.
 */
export interface QwenAgentTaskSnapshot {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly status: QwenAgentTaskLifecycleStatus;
  readonly startTime: number;
  readonly runtimeMs: number;
  readonly isBackgrounded: boolean;
  readonly subagentType?: string;
  readonly toolUseId?: string;
  readonly parentAgentId?: string;
  readonly error?: string;
  readonly resumeBlockedReason?: string;
  readonly stats?: QwenTaskStatsSnapshot;
  readonly recentActivities?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly at: number;
  }>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asNonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const readStats = (value: unknown): QwenTaskStatsSnapshot | undefined => {
  const record = asRecord(value);
  if (record === null) return undefined;
  const totalTokens = asNonNegativeInt(record["totalTokens"]);
  const outputTokens = asNonNegativeInt(record["outputTokens"]);
  const toolUses = asNonNegativeInt(record["toolUses"]);
  const durationMs = asNonNegativeInt(record["durationMs"]);
  if (
    totalTokens === undefined &&
    outputTokens === undefined &&
    toolUses === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

const readActivities = (
  value: unknown,
): ReadonlyArray<{ name: string; description: string; at: number }> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const rows: Array<{ name: string; description: string; at: number }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const name = asText(record["name"]);
    if (name === undefined) continue;
    rows.push({
      name,
      description: asText(record["description"]) ?? "",
      at: asFiniteNumber(record["at"]) ?? 0,
    });
  }
  return rows.length > 0 ? rows : undefined;
};

/**
 * Decodes ONE `tasks[]` entry. Returns undefined for anything that is not an
 * `kind: "agent"` row with the four fields the serializer writes
 * unconditionally (tasksSnapshot.ts:45-52) — shell and monitor rows share the
 * array (tasksSnapshot.ts:130-143) and must be skipped, not coerced.
 */
export const readQwenAgentTaskSnapshot = (value: unknown): QwenAgentTaskSnapshot | undefined => {
  const record = asRecord(value);
  if (record === null) return undefined;
  if (record["kind"] !== "agent") return undefined;
  const id = asText(record["id"]);
  const status = record["status"];
  if (id === undefined || typeof status !== "string" || !LIFECYCLE_STATUSES.has(status)) {
    return undefined;
  }
  const stats = readStats(record["stats"]);
  const recentActivities = readActivities(record["recentActivities"]);
  const subagentType = asText(record["subagentType"]);
  const toolUseId = asText(record["toolUseId"]);
  const parentAgentId = asText(record["parentAgentId"]);
  const error = asText(record["error"]);
  const resumeBlockedReason = asText(record["resumeBlockedReason"]);
  return {
    id,
    // `label`/`description` are non-optional in the serializer but a fork could
    // still send an empty one; the row needs SOME text, and the id is the only
    // thing guaranteed to exist.
    label: asText(record["label"]) ?? id,
    description: asText(record["description"]) ?? asText(record["label"]) ?? id,
    status: status as QwenAgentTaskLifecycleStatus,
    startTime: asFiniteNumber(record["startTime"]) ?? 0,
    runtimeMs: asFiniteNumber(record["runtimeMs"]) ?? 0,
    // tasksSnapshot.ts:55 writes it unconditionally; strict `=== true` keeps a
    // missing field meaning foreground rather than defaulting to background.
    isBackgrounded: record["isBackgrounded"] === true,
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(resumeBlockedReason !== undefined ? { resumeBlockedReason } : {}),
    ...(stats !== undefined ? { stats } : {}),
    ...(recentActivities !== undefined ? { recentActivities } : {}),
  };
};

/**
 * Decodes the whole `qwen/status/session/tasks` answer
 * (`ServeSessionTasksStatus`, status.ts:688-693 / tasksSnapshot.ts:145-150).
 *
 * Returns undefined for a non-envelope — which a `-32601` never reaches, since
 * that fails the request outright, but a fork answering something else would.
 * An envelope with an empty/absent `tasks` array decodes to an EMPTY LIST, not
 * undefined: "no tasks" is a legitimate answer and must not read as an error.
 */
export const readQwenSessionTasks = (
  response: unknown,
): ReadonlyArray<QwenAgentTaskSnapshot> | undefined => {
  const record = asRecord(response);
  if (record === null) return undefined;
  const tasks = record["tasks"];
  if (tasks === undefined || tasks === null) return [];
  if (!Array.isArray(tasks)) return undefined;
  const rows: QwenAgentTaskSnapshot[] = [];
  for (const entry of tasks) {
    const row = readQwenAgentTaskSnapshot(entry);
    if (row !== undefined) rows.push(row);
  }
  return rows;
};

/**
 * One frame of qwen's self-initiated notification pseudo-turn.
 *
 * `source` is the ONLY thing separating qwen's canned completion line from the
 * model's own narration on the wire (Session.ts:6034 vs :6055); both carry the
 * same `backgroundTask` block (:6036-6041 / :6057-6062), which is where the
 * task id joins this content to the row the poll is driving.
 */
export interface QwenBackgroundNotificationFrame {
  readonly source: "background_notification" | "background_notification_response";
  readonly taskId?: string;
  readonly status?: QwenAgentTaskLifecycleStatus;
  readonly toolUseId?: string;
}

const NOTIFICATION_SOURCES: ReadonlySet<string> = new Set([
  "background_notification",
  "background_notification_response",
]);

/**
 * Reads `rawPayload.update._meta` for a pseudo-turn frame, guarding every level.
 *
 * This is the ONLY structured marker that distinguishes background content from
 * the parent's own words, and it exists at v0.21.1 — unlike the LAUNCH frame's
 * `_meta`, which carries no task id at all (research §9.3). Recognising it is
 * what lets the content get a message of its own instead of being folded into
 * whatever assistant segment happens to be open.
 */
export const readQwenBackgroundNotification = (
  rawPayload: unknown,
): QwenBackgroundNotificationFrame | undefined => {
  const update = asRecord(asRecord(rawPayload)?.["update"]);
  const meta = asRecord(update?.["_meta"]);
  if (meta === null) return undefined;
  const source = asText(meta["source"]);
  if (source === undefined || !NOTIFICATION_SOURCES.has(source)) return undefined;
  const task = asRecord(meta["backgroundTask"]);
  const taskId = asText(task?.["taskId"]);
  const status = task?.["status"];
  const toolUseId = asText(task?.["toolUseId"]);
  return {
    source: source as QwenBackgroundNotificationFrame["source"],
    ...(taskId !== undefined ? { taskId } : {}),
    ...(typeof status === "string" && LIFECYCLE_STATUSES.has(status)
      ? { status: status as QwenAgentTaskLifecycleStatus }
      : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
  };
};

/**
 * qwen's own human-facing completion line (background-tasks.ts:1556-1564,
 * `buildBackgroundEntryLabel` at :175-194).
 *
 * Rebuilt here for ONE case: the poll saw a task go terminal and qwen's push
 * never arrived — its notification queue caps at 20 and evicts silently
 * (research §16.6), and any `session/prompt` landing mid-delivery discards the
 * queue outright (§10.4). The pull is the guarantee, so the row's chat message
 * has to be reconstructible from the snapshot alone. Every word is qwen's; the
 * only thing we supply is the decision to say it.
 *
 * ru-code (agentic-flow wave, FIX ROUND 3, F-A4): THE SENTENCE ENDS HERE. This
 * builder used to append `"\nError: " + error`, which made the claim above
 * false: qwen's user-facing line is `displayLine` (`:1563`) and carries no error
 * suffix on any status. `Error: ` exists only inside the MODEL-FACING
 * `<task-notification>` XML (`:1580-1581`) — the exact envelope this wave
 * guarantees never reaches a user surface — so the suffix was a server-side
 * English literal lifted from a model surface, and push and pull rendered the
 * same event differently. The failure's own text is not lost: it rides the row's
 * terminal (`task.completed.summary`/`detail`), which is where the panel shows it.
 */
export const qwenBackgroundCompletionLine = (input: {
  readonly label: string;
  readonly status: QwenAgentTaskLifecycleStatus;
}): string => {
  const statusText =
    input.status === "completed"
      ? "completed"
      : input.status === "failed"
        ? "failed"
        : "was cancelled";
  return `Background agent "${input.label}" ${statusText}.`;
};

/**
 * The `qwen/control/session/task/cancel` params (acpAgent.ts:9374-9398). All
 * three are REQUIRED — `taskKind` has no default and anything outside
 * `agent|shell|monitor` throws `invalidParams`.
 */
export const qwenTaskCancelParams = (input: {
  readonly sessionId: string;
  readonly taskId: string;
}): Record<string, unknown> => ({
  sessionId: input.sessionId,
  taskId: input.taskId,
  taskKind: "agent",
});

/** The cancel answer (acpAgent.ts:9415/:9425). Never an error for a no-op. */
export interface QwenTaskCancelOutcome {
  readonly cancelled: boolean;
  readonly status?: QwenAgentTaskLifecycleStatus;
  readonly reason?: string;
}

export const readQwenTaskCancelOutcome = (response: unknown): QwenTaskCancelOutcome => {
  const record = asRecord(response);
  if (record === null) return { cancelled: false };
  const status = record["status"];
  const reason = asText(record["reason"]);
  return {
    cancelled: record["cancelled"] === true,
    ...(typeof status === "string" && LIFECYCLE_STATUSES.has(status)
      ? { status: status as QwenAgentTaskLifecycleStatus }
      : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
};
