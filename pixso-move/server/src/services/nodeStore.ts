import type { DesignerId, NodeId, NodeRecord, NodeSummary } from "@pixso-move/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface NodeInsert {
  readonly designerId: DesignerId;
  readonly rootName: string;
  readonly nodesJson: string;
  readonly preview: string;
}

export interface NodeForProcessing {
  readonly nodeId: NodeId;
  readonly rootName: string;
  readonly nodesJson: string;
}

// All methods orDie on DB errors (a SQL failure is a defect → HTTP 500), so the
// shape stays clean (no error/requirement channels leak to callers).
export interface NodeStoreShape {
  readonly insert: (input: NodeInsert) => Effect.Effect<{ readonly nodeId: NodeId }>;
  readonly listSummaries: (designerId: DesignerId) => Effect.Effect<ReadonlyArray<NodeSummary>>;
  readonly getById: (
    designerId: DesignerId,
    nodeId: NodeId,
  ) => Effect.Effect<NodeRecord | undefined>;
  readonly listNodeIds: (designerId: DesignerId) => Effect.Effect<ReadonlyArray<NodeId>>;
  readonly getForProcessing: (nodeId: NodeId) => Effect.Effect<NodeForProcessing | undefined>;
}

export class NodeStore extends Context.Service<NodeStore, NodeStoreShape>()(
  "@pixso-move/server/services/nodeStore",
) {}
