import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./base.ts";
import { NodeId, ResultTag } from "./ids.ts";

export const ProcessingStatus = Schema.Literals(["pending", "processing", "done", "error"]);
export type ProcessingStatus = typeof ProcessingStatus.Type;

// One row per (node × configured prompt): both the lifecycle status and the output.
export const ProcessingResult = Schema.Struct({
  nodeId: NodeId,
  resultTag: ResultTag,
  status: ProcessingStatus,
  attempts: NonNegativeInt,
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});
export type ProcessingResult = typeof ProcessingResult.Type;
