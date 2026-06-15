import type { DesignerId, NodeRecord, NodeSummary } from "@pixso-move/contracts";
import { NodeId } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { nowIso } from "../time.ts";
import { NodeStore, type NodeForProcessing, type NodeInsert } from "./nodeStore.ts";

interface SummaryRow {
  readonly id: string;
  readonly root_name: string;
  readonly preview: string;
  readonly added_at: string;
}
interface RecordRow extends SummaryRow {
  readonly designer_id: string;
  readonly nodes_json: string;
}

const toSummary = (r: SummaryRow): NodeSummary => ({
  nodeId: NodeId.make(r.id),
  rootName: r.root_name,
  addedAt: r.added_at,
  preview: r.preview,
});

export const NodeStoreLive = Layer.effect(
  NodeStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      insert: (input: NodeInsert) =>
        Effect.gen(function* () {
          const nodeId = NodeId.make(crypto.randomUUID());
          const addedAt = yield* nowIso;
          yield* sql`
            INSERT INTO nodes (id, designer_id, root_name, nodes_json, preview, added_at)
            VALUES (${nodeId}, ${input.designerId}, ${input.rootName}, ${input.nodesJson}, ${input.preview}, ${addedAt})
          `;
          return { nodeId };
        }).pipe(Effect.orDie),

      listSummaries: (designerId: DesignerId) =>
        sql<SummaryRow>`
          SELECT id, root_name, preview, added_at FROM nodes
          WHERE designer_id = ${designerId} ORDER BY added_at DESC, rowid DESC
        `.pipe(
          Effect.map((rows) => rows.map(toSummary)),
          Effect.orDie,
        ),

      getById: (designerId: DesignerId, nodeId: NodeId) =>
        sql<RecordRow>`
          SELECT id, designer_id, root_name, nodes_json, preview, added_at FROM nodes
          WHERE id = ${nodeId} AND designer_id = ${designerId}
        `.pipe(
          Effect.map((rows): NodeRecord | undefined => {
            const r = rows[0];
            return r === undefined
              ? undefined
              : {
                  nodeId: NodeId.make(r.id),
                  designerId,
                  rootName: r.root_name,
                  nodesJson: r.nodes_json,
                  preview: r.preview,
                  addedAt: r.added_at,
                };
          }),
          Effect.orDie,
        ),

      listNodeIds: (designerId: DesignerId) =>
        sql<{ readonly id: string }>`SELECT id FROM nodes WHERE designer_id = ${designerId}`.pipe(
          Effect.map((rows) => rows.map((r) => NodeId.make(r.id))),
          Effect.orDie,
        ),

      getForProcessing: (nodeId: NodeId) =>
        sql<{ readonly id: string; readonly root_name: string; readonly nodes_json: string }>`
          SELECT id, root_name, nodes_json FROM nodes WHERE id = ${nodeId}
        `.pipe(
          Effect.map((rows): NodeForProcessing | undefined => {
            const r = rows[0];
            return r === undefined
              ? undefined
              : { nodeId: NodeId.make(r.id), rootName: r.root_name, nodesJson: r.nodes_json };
          }),
          Effect.orDie,
        ),
    };
  }),
);
