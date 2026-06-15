import { DesignerId, NodeId, ResultTag } from "@pixso-move/contracts";
import { describe, expect, it } from "vitest";

import {
  computeReconcileRows,
  configuredDesignerIds,
  resolvePrompt,
} from "../src/reconcile.ts";
import type { ProcessorConfig } from "../src/types.ts";

const dz = (s: string) => DesignerId.make(s);
const node = (s: string) => NodeId.make(s);
const tag = (s: string) => ResultTag.make(s);

const config: ProcessorConfig = [
  { designerId: dz("dz_a"), prompt: "P1", resultTag: tag("html") },
  { designerId: dz("dz_a"), prompt: "P2", resultTag: tag("summary") },
  { designerId: dz("dz_b"), prompt: "P3", resultTag: tag("html") },
];

describe("computeReconcileRows", () => {
  it("crosses each configured designer's nodes with that designer's tags", () => {
    const rows = computeReconcileRows(
      config,
      new Map([
        [dz("dz_a"), [node("n1"), node("n2")]],
        [dz("dz_b"), [node("n3")]],
      ]),
    );
    // dz_a: 2 nodes × 2 tags = 4; dz_b: 1 node × 1 tag = 1.
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.resultTag === "summary")).toHaveLength(2);
    expect(rows.every((r) => r.designerId === "dz_a" || r.designerId === "dz_b")).toBe(true);
  });

  it("produces no rows for a configured designer with no nodes", () => {
    expect(computeReconcileRows(config, new Map())).toHaveLength(0);
  });
});

describe("configuredDesignerIds", () => {
  it("returns distinct designer ids", () => {
    expect(configuredDesignerIds(config)).toEqual([dz("dz_a"), dz("dz_b")]);
  });
});

describe("resolvePrompt", () => {
  it("finds the prompt for a designer+tag pair", () => {
    expect(resolvePrompt(config, dz("dz_a"), tag("summary"))).toBe("P2");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolvePrompt(config, dz("dz_a"), tag("missing"))).toBeUndefined();
  });
});
