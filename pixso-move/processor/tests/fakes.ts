import type { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import * as Effect from "effect/Effect";

import {
  AcpRunError,
  type AcpRunnerShape,
  type ClaimedJob,
  type NodeForProcessing,
  type ProcessorDeps,
  type ReconcileRow,
} from "../src/types.ts";

export interface FakeResultRow {
  id: string;
  designerId: DesignerId;
  nodeId: NodeId;
  resultTag: ResultTag;
  status: "pending" | "processing" | "done" | "error";
  attempts: number;
  result: string | null;
  error: string | null;
}

export interface FakeState {
  readonly nodeIdsByDesigner: Map<string, NodeId[]>;
  readonly nodes: Map<string, NodeForProcessing>;
  readonly rows: FakeResultRow[];
  seq: number;
}

export const makeState = (): FakeState => ({
  nodeIdsByDesigner: new Map(),
  nodes: new Map(),
  rows: [],
  seq: 0,
});

export const addNode = (
  state: FakeState,
  designerId: DesignerId,
  node: NodeForProcessing,
): void => {
  const list = state.nodeIdsByDesigner.get(designerId) ?? [];
  list.push(node.nodeId);
  state.nodeIdsByDesigner.set(designerId, list);
  state.nodes.set(node.nodeId, node);
};

// In-memory ProcessorDeps mirroring the server stores' observable behaviour (claim bumps
// attempts; reconcile is idempotent on node+tag; recovery flips processing→pending).
export const makeDeps = (state: FakeState, acp: AcpRunnerShape): ProcessorDeps => ({
  listNodeIds: (designerId) =>
    Effect.sync(() => state.nodeIdsByDesigner.get(designerId) ?? []),
  getForProcessing: (nodeId) => Effect.sync(() => state.nodes.get(nodeId)),
  reconcile: (rows: ReadonlyArray<ReconcileRow>) =>
    Effect.sync(() => {
      let inserted = 0;
      for (const row of rows) {
        const exists = state.rows.some(
          (r) => r.nodeId === row.nodeId && r.resultTag === row.resultTag,
        );
        if (exists) continue;
        state.rows.push({
          id: `r${state.seq++}`,
          designerId: row.designerId,
          nodeId: row.nodeId,
          resultTag: row.resultTag,
          status: "pending",
          attempts: 0,
          result: null,
          error: null,
        });
        inserted += 1;
      }
      return inserted;
    }),
  claimNextPending: Effect.sync(() => {
    const row = state.rows.find((r) => r.status === "pending");
    if (row === undefined) return undefined;
    row.status = "processing";
    row.attempts += 1;
    return {
      id: row.id,
      designerId: row.designerId,
      nodeId: row.nodeId,
      resultTag: row.resultTag,
    } satisfies ClaimedJob;
  }),
  complete: (id, result) =>
    Effect.sync(() => {
      const row = state.rows.find((r) => r.id === id);
      if (row) {
        row.status = "done";
        row.result = result;
        row.error = null;
      }
    }),
  fail: (id, error) =>
    Effect.sync(() => {
      const row = state.rows.find((r) => r.id === id);
      if (row) {
        row.status = "error";
        row.error = error;
      }
    }),
  recoverInFlight: Effect.sync(() => {
    let count = 0;
    for (const row of state.rows) {
      if (row.status === "processing") {
        row.status = "pending";
        count += 1;
      }
    }
    return count;
  }),
  acp,
});

export const scriptedAcp = (text: string, stopReason = "end_turn"): AcpRunnerShape => ({
  run: () => Effect.succeed({ text, stopReason }),
});

export const failingAcp = (message: string): AcpRunnerShape => ({
  run: () => Effect.fail(new AcpRunError({ message })),
});

export const dyingAcp = (defect: string): AcpRunnerShape => ({
  run: () => Effect.die(defect),
});
