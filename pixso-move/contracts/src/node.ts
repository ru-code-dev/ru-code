import * as Schema from "effect/Schema";

import { Base64Png } from "./ingest.ts";
import { DesignerId, NodeId } from "./ids.ts";

// Lightweight list item (no nodes_json) — returned by GET /nodes.
export const NodeSummary = Schema.Struct({
  nodeId: NodeId,
  rootName: Schema.String,
  addedAt: Schema.String,
  preview: Base64Png,
});
export type NodeSummary = typeof NodeSummary.Type;

// Full record (incl. nodes_json) — returned by GET /nodes/:id.
export const NodeRecord = Schema.Struct({
  nodeId: NodeId,
  designerId: DesignerId,
  rootName: Schema.String,
  nodesJson: Schema.String,
  preview: Base64Png,
  addedAt: Schema.String,
});
export type NodeRecord = typeof NodeRecord.Type;
