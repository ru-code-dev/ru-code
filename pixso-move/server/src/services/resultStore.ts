import type { DesignerId, NodeId, ProcessingResult, ResultTag } from "@pixso-move/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ReconcileRow {
  readonly designerId: DesignerId;
  readonly nodeId: NodeId;
  readonly resultTag: ResultTag;
}

export interface ClaimedJob {
  readonly id: string;
  readonly designerId: DesignerId;
  readonly nodeId: NodeId;
  readonly resultTag: ResultTag;
}

// All methods orDie on DB errors (SQL failure = defect → HTTP 500).
export interface ResultStoreShape {
  readonly reconcile: (rows: ReadonlyArray<ReconcileRow>) => Effect.Effect<number>;
  readonly claimNextPending: Effect.Effect<ClaimedJob | undefined>;
  readonly complete: (id: string, result: string) => Effect.Effect<void>;
  readonly fail: (id: string, error: string) => Effect.Effect<void>;
  readonly recoverInFlight: Effect.Effect<number>;
  readonly listByNode: (
    designerId: DesignerId,
    nodeId: NodeId,
  ) => Effect.Effect<ReadonlyArray<ProcessingResult>>;
  readonly countPending: Effect.Effect<number>;
}

export class ResultStore extends Context.Service<ResultStore, ResultStoreShape>()(
  "@pixso-move/server/services/resultStore",
) {}
