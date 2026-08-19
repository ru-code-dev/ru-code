/**
 * ru-code: QwenCompactionHistory — the adapter's read window into a thread's
 * persisted activity history, scoped to what the compaction machinery needs
 * (circuit-breaker state). The adapter deliberately never talks to the
 * projection layer directly; this fork-owned service wraps
 * `ProjectionSnapshotQuery` and is provided next to `QwenModelDiscoveryStore`
 * in the runtime layer, so `QwenDriver` can inject a plain Effect into the
 * adapter (same pattern as `getAutoCompactContext`).
 *
 * Read errors degrade to the empty state — the breaker then stays armed, which
 * at worst costs one compression that immediately re-derives the truth.
 *
 * @module ru-code/qwen/compaction/QwenCompactionHistory
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  deriveThreadCompactionState,
  type QwenThreadCompactionState,
} from "./compactionHistory.ts";

export interface QwenCompactionHistoryShape {
  readonly getThreadCompactionState: (
    threadId: ThreadId,
  ) => Effect.Effect<QwenThreadCompactionState>;
}

const EMPTY_STATE: QwenThreadCompactionState = { lastCompaction: null, minUsedTokensSince: null };

export class QwenCompactionHistory extends Context.Service<
  QwenCompactionHistory,
  QwenCompactionHistoryShape
>()("t3/ru-code/qwen/compaction/QwenCompactionHistory") {
  static layer(): Layer.Layer<QwenCompactionHistory, never, ProjectionSnapshotQuery> {
    return Layer.effect(
      QwenCompactionHistory,
      Effect.gen(function* () {
        const projectionQuery = yield* ProjectionSnapshotQuery;
        const getThreadCompactionState: QwenCompactionHistoryShape["getThreadCompactionState"] = (
          threadId,
        ) =>
          projectionQuery.getThreadDetailById(threadId).pipe(
            Effect.map((thread) =>
              Option.match(thread, {
                onNone: () => EMPTY_STATE,
                onSome: (detail) => deriveThreadCompactionState(detail.activities),
              }),
            ),
            Effect.catch((error) =>
              Effect.logDebug("[qwen-compaction] history read failed — breaker stays armed", {
                threadId,
                error,
              }).pipe(Effect.as(EMPTY_STATE)),
            ),
          );
        return { getThreadCompactionState };
      }),
    );
  }

  /** Canned-state layer for tests. */
  static layerTest(
    state: QwenThreadCompactionState = EMPTY_STATE,
  ): Layer.Layer<QwenCompactionHistory> {
    return Layer.succeed(QwenCompactionHistory, {
      getThreadCompactionState: () => Effect.succeed(state),
    });
  }
}
