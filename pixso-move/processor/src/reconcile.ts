import type { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";

import type { ProcessorConfig, ReconcileRow } from "./types.ts";

// Cross each configured designer's nodes with that designer's result tags. Only configured
// designers produce rows. Pure — the engine supplies `nodesByDesigner` via the deps.
export const computeReconcileRows = (
  config: ProcessorConfig,
  nodesByDesigner: ReadonlyMap<DesignerId, ReadonlyArray<NodeId>>,
): ReadonlyArray<ReconcileRow> => {
  const rows: ReconcileRow[] = [];
  for (const entry of config) {
    for (const nodeId of nodesByDesigner.get(entry.designerId) ?? []) {
      rows.push({ designerId: entry.designerId, nodeId, resultTag: entry.resultTag });
    }
  }
  return rows;
};

// The distinct designer ids referenced by the config (whose nodes the engine fetches).
export const configuredDesignerIds = (config: ProcessorConfig): ReadonlyArray<DesignerId> => [
  ...new Set(config.map((entry) => entry.designerId)),
];

// The prompt configured for a (designer, tag) pair, or undefined if none matches.
export const resolvePrompt = (
  config: ProcessorConfig,
  designerId: DesignerId,
  resultTag: ResultTag,
): string | undefined =>
  config.find((entry) => entry.designerId === designerId && entry.resultTag === resultTag)
    ?.prompt;
