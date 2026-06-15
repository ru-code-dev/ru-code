import type { ProcessingResult, ProcessingStatus } from "@pixso-move/contracts";
import { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { nowIso } from "../time.ts";
import { ResultStore, type ClaimedJob, type ReconcileRow } from "./resultStore.ts";

interface ResultRow {
  readonly node_id: string;
  readonly result_tag: string;
  readonly status: string;
  readonly attempts: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

const toResult = (r: ResultRow): ProcessingResult => ({
  nodeId: NodeId.make(r.node_id),
  resultTag: ResultTag.make(r.result_tag),
  status: r.status as ProcessingStatus,
  attempts: r.attempts,
  result: r.result,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const ResultStoreLive = Layer.effect(
  ResultStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      reconcile: (rows: ReadonlyArray<ReconcileRow>) =>
        Effect.gen(function* () {
          let inserted = 0;
          for (const row of rows) {
            const createdAt = yield* nowIso;
            const out = yield* sql<{ readonly id: string }>`
              INSERT INTO processing_results
                (id, designer_id, node_id, result_tag, status, attempts, created_at)
              VALUES (${crypto.randomUUID()}, ${row.designerId}, ${row.nodeId}, ${row.resultTag}, 'pending', 0, ${createdAt})
              ON CONFLICT (node_id, result_tag) DO NOTHING
              RETURNING id
            `;
            inserted += out.length;
          }
          return inserted;
        }).pipe(Effect.orDie),

      claimNextPending: Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const rows = yield* sql<{
          readonly id: string;
          readonly designer_id: string;
          readonly node_id: string;
          readonly result_tag: string;
        }>`
          UPDATE processing_results
          SET status = 'processing', started_at = ${startedAt}, attempts = attempts + 1
          WHERE id = (
            SELECT id FROM processing_results WHERE status = 'pending'
            ORDER BY created_at LIMIT 1
          ) AND status = 'pending'
          RETURNING id, designer_id, node_id, result_tag
        `;
        const r = rows[0];
        return r === undefined
          ? undefined
          : ({
              id: r.id,
              designerId: DesignerId.make(r.designer_id),
              nodeId: NodeId.make(r.node_id),
              resultTag: ResultTag.make(r.result_tag),
            } satisfies ClaimedJob);
      }).pipe(Effect.orDie),

      complete: (id: string, result: string) =>
        Effect.gen(function* () {
          const finishedAt = yield* nowIso;
          yield* sql`
            UPDATE processing_results
            SET status = 'done', result = ${result}, error = NULL, finished_at = ${finishedAt}
            WHERE id = ${id}
          `;
        }).pipe(Effect.orDie),

      fail: (id: string, error: string) =>
        Effect.gen(function* () {
          const finishedAt = yield* nowIso;
          yield* sql`
            UPDATE processing_results
            SET status = 'error', error = ${error}, finished_at = ${finishedAt}
            WHERE id = ${id}
          `;
        }).pipe(Effect.orDie),

      recoverInFlight: sql<{ readonly id: string }>`
        UPDATE processing_results SET status = 'pending'
        WHERE status = 'processing' RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
      ),

      listByNode: (designerId, nodeId) =>
        sql<ResultRow>`
          SELECT node_id, result_tag, status, attempts, result, error, created_at, started_at, finished_at
          FROM processing_results WHERE designer_id = ${designerId} AND node_id = ${nodeId}
          ORDER BY result_tag
        `.pipe(
          Effect.map((rows) => rows.map(toResult)),
          Effect.orDie,
        ),

      countPending: sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM processing_results WHERE status = 'pending'
      `.pipe(
        Effect.map((rows) => rows.reduce((total, row) => total + row.c, 0)),
        Effect.orDie,
      ),
    };
  }),
);
