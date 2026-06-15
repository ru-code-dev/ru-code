import * as Schema from "effect/Schema";

import { DesignerId, NodeId } from "./ids.ts";

// base64 PNG (no `data:` prefix); ~8MB guard rejects oversize previews at the edge.
export const Base64Png = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8 * 1024 * 1024));
export type Base64Png = typeof Base64Png.Type;

export const IngestRequest = Schema.Struct({
  designerId: DesignerId,
  rootName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  // opaque, already-serialized JSON string; stored verbatim (min length 2 = "{}"/"[]").
  nodesJson: Schema.String.check(Schema.isMinLength(2)),
  preview: Base64Png,
});
export type IngestRequest = typeof IngestRequest.Type;

export const IngestResponse = Schema.Struct({ nodeId: NodeId });
export type IngestResponse = typeof IngestResponse.Type;
