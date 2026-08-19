/**
 * ru-code: boot sweep — reconcile qwen threads' persisted history with the
 * one fact only a fresh server process knows for certain: nothing outlives
 * the previous process. Compressions and parked requests (approvals,
 * questions, plan approvals) die with it, but their "open" rows survive in
 * history; left dangling they block send (open compaction task) or offer
 * answers that can only fail (parked panels).
 *
 * The sweep closes them through the SAME single-writer path every other row
 * uses — ordinary `thread.activity.append` engine dispatches — so consumers
 * (send block, timeline, breaker) keep reading plain history with no
 * read-side special cases. Gated to qwen-kind bindings: other providers keep
 * upstream's lazy-heal behavior byte-identical.
 *
 * @module ru-code/startup/qwenBootSweep
 */
import { QWEN_KIND } from "@ru-code/branding";
import {
  CommandId,
  EventId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  findDanglingCompactionTaskIds,
  findDanglingParkedRequests,
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

/**
 * The whole sweep decision for one thread, pure: which closing rows its
 * history needs. Compaction closures reuse the morphing row's task pair
 * (`task.completed{stopped}` under the same taskId — the web merges it into
 * the spinner row and unblocks send); request closures reuse the exact kinds
 * the pending-panel derivations already treat as terminal.
 */
export function planQwenBootSweepRows(
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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

/** The sweep's dependencies, explicit so tests can drive the exact prod path. */
export interface QwenBootSweepDeps {
  readonly listBindings: ProviderSessionDirectory["Service"]["listBindings"];
  readonly getThreadDetailById: ProjectionSnapshotQuery["Service"]["getThreadDetailById"];
  readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
  readonly randomUuid: Effect.Effect<string>;
}

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
      const detail = yield* deps
        .getThreadDetailById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!detail) continue;

      for (const row of planQwenBootSweepRows(threadId, detail.activities)) {
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
  yield* runQwenBootSweepWith({
    listBindings: () => directory.listBindings(),
    getThreadDetailById: projectionQuery.getThreadDetailById,
    dispatch: engine.dispatch,
    randomUuid: crypto.randomUUIDv4.pipe(Effect.orDie),
  });
});
