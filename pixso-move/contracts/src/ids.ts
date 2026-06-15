import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./base.ts";

export const DesignerId = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).pipe(
  Schema.brand("DesignerId"),
);
export type DesignerId = typeof DesignerId.Type;

export const NodeId = TrimmedNonEmptyString.pipe(Schema.brand("NodeId"));
export type NodeId = typeof NodeId.Type;

export const ResultTag = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("ResultTag"),
);
export type ResultTag = typeof ResultTag.Type;
