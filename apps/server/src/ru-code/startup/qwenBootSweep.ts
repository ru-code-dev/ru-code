/**
 * ru-code: boot sweep — reconcile qwen threads' persisted history with the
 * one fact only a fresh server process knows for certain: nothing outlives
 * the previous process. Compressions and parked requests (approvals,
 * questions, plan approvals) die with it, but their "open" rows survive in
 * history; left dangling they block send (open compaction task) or offer
 * answers that can only fail (parked panels). The SESSION row dies with the
 * process too: a persisted `status: "running"` + `activeTurnId` makes the web
 * derive a live "Working" phase (spinner, ticking timer, active Stop button)
 * for a turn that no longer exists — and pressing that Stop resurrects a
 * session (allowRecovery interrupt routing) only to kill it. And the
 * assistant message the process was STREAMING keeps `streaming: true`
 * forever, which blocks the timeline from ever folding that turn under
 * "Worked".
 *
 * The sweep closes all of it through the SAME single-writer path every other
 * writer uses — ordinary `thread.activity.append` / `thread.session.set`
 * engine dispatches — so consumers (send block, timeline, breaker, phase
 * derivations, WS subscribers) keep reading plain projections with no
 * read-side special cases. The session write is the exact shape of the Stop
 * handler's (`processSessionStopRequested`): the projector already treats a
 * session leaving "running" as the authoritative turn end and settles every
 * still-running turn row ("stopped" ⇒ "interrupted" + completedAt), so a
 * restarted server converges to the SAME state an ordinary Stop produces — a
 * state every flow (send-resumes, compact-on-stopped) already handles. Gated
 * to qwen-kind bindings: other providers keep upstream's lazy-heal behavior
 * byte-identical.
 *
 * @module ru-code/startup/qwenBootSweep
 */
import { QWEN_KIND } from "@ru-code/branding";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  findDanglingCompactionTaskIds,
  findDanglingParkedRequests,
  findDanglingSubAgentTaskIds,
  SWEEP_ACTIVITY_KINDS,
  type SweepActivityInput,
} from "../qwen/compaction/compactionHistory.ts";

export interface QwenBootSweepRowSpec {
  readonly threadId: ThreadId;
  readonly kind: string;
  readonly tone: OrchestrationThreadActivity["tone"];
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

export const INTERRUPTED_COMPACTION_TEXT = "Compaction interrupted by a server restart.";
export const CANCELLED_APPROVAL_TEXT = "Approval request cancelled by a server restart.";
export const CANCELLED_USER_INPUT_TEXT = "Question cancelled by a server restart.";
// ru-code (P2 zombie settle, boot-sweep half): mirrors the adapter-side
// settle's "Stopped by the user." detail — this is the dead-process case, so
// the text says restart instead.
export const INTERRUPTED_AGENT_TEXT = "Agent interrupted by a server restart.";

/**
 * The whole sweep decision for one thread, pure: which closing rows its
 * history needs. Compaction closures reuse the morphing row's task pair
 * (`task.completed{stopped}` under the same taskId — the web merges it into
 * the spinner row and unblocks send); request closures reuse the exact kinds
 * the pending-panel derivations already treat as terminal. Sub-agent closures
 * (P2 zombie settle) are the boot-time complement to the adapter's teardown
 * settle — an agent open when the process was SIGKILLed / lost power never
 * ran `abortSession`, so only the next boot can close its row.
 */
export function planQwenBootSweepRows(
  threadId: ThreadId,
  activities: ReadonlyArray<SweepActivityInput>,
): ReadonlyArray<QwenBootSweepRowSpec> {
  const rows: QwenBootSweepRowSpec[] = [];
  for (const taskId of findDanglingCompactionTaskIds(activities)) {
    rows.push({
      threadId,
      kind: "task.completed",
      tone: "info",
      summary: INTERRUPTED_COMPACTION_TEXT,
      payload: { taskId, status: "stopped", detail: INTERRUPTED_COMPACTION_TEXT },
    });
  }
  for (const taskId of findDanglingSubAgentTaskIds(activities)) {
    rows.push({
      threadId,
      kind: "task.completed",
      tone: "info",
      summary: INTERRUPTED_AGENT_TEXT,
      payload: { taskId, status: "stopped", detail: INTERRUPTED_AGENT_TEXT },
    });
  }
  for (const request of findDanglingParkedRequests(activities)) {
    rows.push({
      threadId,
      kind: request.kind === "approval" ? "approval.resolved" : "user-input.resolved",
      tone: "info",
      summary: request.kind === "approval" ? CANCELLED_APPROVAL_TEXT : CANCELLED_USER_INPUT_TEXT,
      payload: { requestId: request.requestId },
    });
  }
  return rows;
}

/** An assistant message the dead process left mid-stream. */
export interface QwenBootSweepStreamingFinalizeSpec {
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  /**
   * The message's own last-delta timestamp — the finalize is dispatched AS OF
   * this moment, not boot time, so the timeline's "Worked for …" duration
   * ends where the work actually ended instead of counting server downtime.
   */
  readonly updatedAt: string;
}

/**
 * The columns the streaming-finalize plan reads — full `OrchestrationMessage`
 * rows remain assignable; the lean boot-sweep SQL read produces exactly this.
 */
export interface SweepStreamingMessageInput {
  readonly id: MessageId;
  readonly role: string;
  readonly streaming: boolean;
  readonly turnId: TurnId | null;
  readonly updatedAt: string;
}

/**
 * The mid-stream messages a dead-process thread needs finalized, pure. Each
 * gets the adapter's own end-of-stream write (`thread.message.assistant.complete`
 * — accumulated text kept, `streaming` flipped off, turn binding preserved);
 * a message left `streaming: true` blocks the timeline's turn fold forever.
 * The lean read pre-filters role/streaming in SQL; the in-plan filter stays as
 * the semantic definition (and keeps full-row callers correct).
 */
export function planQwenBootSweepStreamingFinalizes(
  messages: ReadonlyArray<SweepStreamingMessageInput>,
): ReadonlyArray<QwenBootSweepStreamingFinalizeSpec> {
  return messages
    .filter((message) => message.role === "assistant" && message.streaming)
    .map((message) => ({
      messageId: message.id,
      turnId: message.turnId,
      updatedAt: message.updatedAt,
    }));
}

/**
 * The session reset a dead-process thread needs, pure: any persisted
 * non-"stopped" status is a claim about a process that no longer exists
 * ("error" included — its banner survives via the wire's `preserveLastError`).
 * Mirrors the Stop handler's write exactly (status "stopped", `activeTurnId`
 * intentionally cleared, provider identity + runtimeMode carried over) so the
 * projector's session-set turn-settling makes restart ≡ Stop. null ⇒ the row
 * is already honest, dispatch nothing.
 */
export function planQwenBootSweepSessionStop(
  session: OrchestrationSession | null,
  updatedAt: string,
): OrchestrationSession | null {
  if (!session || session.status === "stopped") {
    return null;
  }
  return {
    threadId: session.threadId,
    status: "stopped",
    providerName: session.providerName,
    ...(session.providerInstanceId !== undefined
      ? { providerInstanceId: session.providerInstanceId }
      : {}),
    runtimeMode: session.runtimeMode,
    activeTurnId: null,
    lastError: session.lastError,
    updatedAt,
  };
}

/**
 * Everything the sweep needs to know about one thread — a fraction of the full
 * thread detail (the previous read): the shell's session row, the mid-stream
 * assistant messages, and the sweep-relevant activity kinds with only the
 * taskId/requestId their derivations read.
 */
export interface QwenSweepThreadState {
  readonly session: OrchestrationSession | null;
  readonly streamingAssistantMessages: ReadonlyArray<SweepStreamingMessageInput>;
  readonly activities: ReadonlyArray<SweepActivityInput>;
}

/** The sweep's dependencies, explicit so tests can drive the exact prod path. */
export interface QwenBootSweepDeps {
  readonly listBindings: ProviderSessionDirectory["Service"]["listBindings"];
  readonly readSweepThreadState: (
    threadId: ThreadId,
  ) => Effect.Effect<QwenSweepThreadState | null, ProjectionRepositoryError>;
  readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
  readonly randomUuid: Effect.Effect<string>;
}

const SweepThreadLookupInput = Schema.Struct({ threadId: ThreadId });
const SweepStreamingMessageRowSchema = Schema.Struct({
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  role: Schema.String,
  isStreaming: Schema.Number,
  updatedAt: Schema.String,
});
const SweepActivityRowSchema = Schema.Struct({
  kind: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  // ru-code (P2 zombie settle, boot-sweep half): `findDanglingSubAgentTaskIds`
  // must only settle a `task.started` row ingestion already stamped
  // `agentKind: "agent"` — without this column the sweep cannot tell a real
  // agent's open row from a background shell/monitor/compaction row sharing
  // the same kind, and would settle (and phantom-CTA) all of them.
  agentKind: Schema.NullOr(Schema.String),
});

const toSweepReadError =
  (sqlOperation: string, decodeOperation: string) =>
  (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);

/**
 * The lean per-thread reader: the shell read (3 small keyed queries — carries
 * the session row and doubles as the missing/deleted-thread check) plus two
 * column-lean SQL reads. Both reads reproduce the full projection reads'
 * ORDER BY exactly (messages: ProjectionSnapshotQuery's by-thread message
 * read; activities: its by-thread activity read — the dangling logic is an
 * ordered open/close replay, so order is semantics, not cosmetics).
 */
export const makeSweepThreadStateReader = (
  sql: SqlClient.SqlClient,
  getThreadShellById: ProjectionSnapshotQuery["Service"]["getThreadShellById"],
): QwenBootSweepDeps["readSweepThreadState"] => {
  const readStreamingAssistantMessageRows = SqlSchema.findAll({
    Request: SweepThreadLookupInput,
    Result: SweepStreamingMessageRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role,
          is_streaming AS "isStreaming",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND is_streaming = 1
          AND role = 'assistant'
        ORDER BY created_at ASC, message_id ASC
      `,
  });
  const readSweepActivityRows = SqlSchema.findAll({
    Request: SweepThreadLookupInput,
    Result: SweepActivityRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          kind,
          json_extract(payload_json, '$.taskId') AS "taskId",
          json_extract(payload_json, '$.requestId') AS "requestId",
          json_extract(payload_json, '$.agentKind') AS "agentKind"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND ${sql.in("kind", SWEEP_ACTIVITY_KINDS)}
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  return (threadId) =>
    Effect.gen(function* () {
      const shell = yield* getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        return null;
      }
      const [messageRows, activityRows] = yield* Effect.all([
        readStreamingAssistantMessageRows({ threadId }).pipe(
          Effect.mapError(
            toSweepReadError(
              "qwenBootSweep.readStreamingMessages:query",
              "qwenBootSweep.readStreamingMessages:decodeRow",
            ),
          ),
        ),
        readSweepActivityRows({ threadId }).pipe(
          Effect.mapError(
            toSweepReadError(
              "qwenBootSweep.readSweepActivities:query",
              "qwenBootSweep.readSweepActivities:decodeRow",
            ),
          ),
        ),
      ]);
      return {
        session: shell.value.session,
        streamingAssistantMessages: messageRows.map((row) => ({
          id: row.messageId,
          role: row.role,
          streaming: row.isStreaming !== 0,
          turnId: row.turnId,
          updatedAt: row.updatedAt,
        })),
        activities: activityRows.map((row) => ({
          kind: row.kind,
          payload: {
            ...(row.taskId !== null ? { taskId: row.taskId } : {}),
            ...(row.requestId !== null ? { requestId: row.requestId } : {}),
            ...(row.agentKind !== null ? { agentKind: row.agentKind } : {}),
          },
        })),
      } satisfies QwenSweepThreadState;
    });
};

/**
 * Run the sweep across every qwen-kind thread binding. Failures are logged
 * and swallowed — a sweep problem must never block startup, and the next
 * boot retries.
 */
export const runQwenBootSweepWith = (deps: QwenBootSweepDeps) =>
  Effect.gen(function* () {
    const bindings = yield* deps.listBindings();
    const qwenThreadIds = bindings
      .filter((binding) => String(binding.provider) === QWEN_KIND)
      .map((binding) => binding.threadId);

    let closedCount = 0;
    for (const threadId of qwenThreadIds) {
      const state = yield* deps.readSweepThreadState(threadId);
      if (!state) continue;

      // Finalizes go FIRST and are BACK-DATED to each message's last delta:
      // `thread.message-sent` also bumps the thread row's updatedAt from the
      // event's occurredAt, and the closures/session-reset dispatched below
      // (stamped now) re-bump it — so the fold duration ends at the last real
      // byte while thread ordering still ends at the sweep. Replay order is
      // sequence-based; occurredAt is display data.
      for (const finalize of planQwenBootSweepStreamingFinalizes(
        state.streamingAssistantMessages,
      )) {
        const commandUuid = yield* deps.randomUuid;
        yield* deps.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(commandUuid),
          threadId,
          messageId: finalize.messageId,
          ...(finalize.turnId !== null ? { turnId: finalize.turnId } : {}),
          createdAt: finalize.updatedAt,
        });
        closedCount += 1;
      }

      for (const row of planQwenBootSweepRows(threadId, state.activities)) {
        const commandUuid = yield* deps.randomUuid;
        const activityUuid = yield* deps.randomUuid;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* deps.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(commandUuid),
          threadId: row.threadId,
          activity: {
            id: EventId.make(activityUuid),
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: null,
            createdAt,
          },
          createdAt,
        });
        closedCount += 1;
      }

      const sessionStopCreatedAt = DateTime.formatIso(yield* DateTime.now);
      const sessionStop = planQwenBootSweepSessionStop(state.session, sessionStopCreatedAt);
      if (sessionStop !== null) {
        const commandUuid = yield* deps.randomUuid;
        yield* deps.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandUuid),
          threadId,
          session: sessionStop,
          // `lastError` above is merely CARRIED OVER from this sweep's
          // projection read; declaring preserve makes the decider re-resolve
          // it at the serialized execution point (same contract as the Stop
          // handler). `activeTurnId` is an intentional clear — no flag.
          preserveLastError: true,
          createdAt: sessionStopCreatedAt,
        });
        closedCount += 1;
      }
    }

    if (closedCount > 0) {
      yield* Effect.logDebug("[qwen-boot-sweep] closed interrupted work", {
        closedCount,
        scannedThreads: qwenThreadIds.length,
      });
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("[qwen-boot-sweep] sweep failed", { cause })),
  );

/** Production entry: resolves the deps from the runtime context. */
export const runQwenBootSweep = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const projectionQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  yield* runQwenBootSweepWith({
    listBindings: () => directory.listBindings(),
    readSweepThreadState: makeSweepThreadStateReader(sql, projectionQuery.getThreadShellById),
    dispatch: engine.dispatch,
    randomUuid: crypto.randomUUIDv4.pipe(Effect.orDie),
  });
});
