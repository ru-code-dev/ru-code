// ru-code: the catalog auto-resync coordinator's ONE reconcile rule. Contract:
// reconcile ⇔ rpcReady ∧ projectsLoaded ∧ (no baseline ∨ project-set changed).
// That single predicate must produce: one boot reconcile per page load, one
// rescan per REAL project-set change, nothing while connecting, nothing on
// reconnect flaps, nothing on reorders, and a working zero-projects boot.
import { describe, expect, it } from "vite-plus/test";

import type { CatalogItem } from "@smart-tools/qwen-cli-catalog-core/contracts";

import {
  projectSetKey,
  sameCatalogItems,
  shouldReconcileCatalogs,
} from "../../../skills-agents/catalog/CatalogAutoResync";

describe("projectSetKey", () => {
  it("is a function of the SET — order-insensitive, duplicates preserved", () => {
    expect(projectSetKey(["b", "a"])).toBe(projectSetKey(["a", "b"]));
    expect(projectSetKey([])).toBe("");
    expect(projectSetKey(["a"])).not.toBe(projectSetKey(["a", "b"]));
  });
});

describe("shouldReconcileCatalogs", () => {
  const ready = { rpcReady: true, projectsLoaded: true };

  it("boot: first satisfaction of the condition fires the one reconcile", () => {
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "a,b", baselineKey: null })).toBe(
      true,
    );
  });

  it("zero-projects boot still reconciles once (global-only skills discovered)", () => {
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "", baselineKey: null })).toBe(true);
  });

  it("NO attempts while connecting or before the project list loads", () => {
    expect(
      shouldReconcileCatalogs({
        rpcReady: false,
        projectsLoaded: true,
        projectSetKey: "a",
        baselineKey: null,
      }),
    ).toBe(false);
    expect(
      shouldReconcileCatalogs({
        rpcReady: true,
        projectsLoaded: false,
        projectSetKey: "a",
        baselineKey: null,
      }),
    ).toBe(false);
  });

  it("reconnect flap with an unchanged set never rescans (baseline holds)", () => {
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "a,b", baselineKey: "a,b" })).toBe(
      false,
    );
  });

  it("a REAL project-set change rescans; a reorder-only change cannot occur (sorted key)", () => {
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "a,b,c", baselineKey: "a,b" })).toBe(
      true,
    );
    expect(
      shouldReconcileCatalogs({
        ...ready,
        projectSetKey: projectSetKey(["b", "a"]),
        baselineKey: projectSetKey(["a", "b"]),
      }),
    ).toBe(false);
  });

  it("removing the last project still reconciles (stale bindings dropped)", () => {
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "", baselineKey: "a" })).toBe(true);
  });

  it("a FAILED reconcile leaves the baseline unset, so the rule retries", () => {
    // The driver only writes the baseline on success — the same predicate that
    // fired the failed attempt stays true and fires again on the next
    // readiness/key change.
    expect(shouldReconcileCatalogs({ ...ready, projectSetKey: "a", baselineKey: null })).toBe(true);
  });
});

describe("sameCatalogItems", () => {
  // Only the fields the comparator cares about matter for these shapes.
  const item = (name: string) => ({ name }) as unknown as CatalogItem;

  it("an unchanged reconcile result skips the prime (no write, no re-render)", () => {
    expect(sameCatalogItems([item("a"), item("b")], [item("a"), item("b")])).toBe(true);
    expect(sameCatalogItems([], [])).toBe(true);
  });

  it("any real change primes: added, removed, mutated, reordered", () => {
    expect(sameCatalogItems([item("a")], [item("a"), item("b")])).toBe(false);
    expect(sameCatalogItems([item("a"), item("b")], [item("a")])).toBe(false);
    expect(sameCatalogItems([item("a")], [item("A")])).toBe(false);
    // Ordering differences prime too — a false "change" merely costs one write
    // (the pre-skip behavior), never a missed update.
    expect(sameCatalogItems([item("a"), item("b")], [item("b"), item("a")])).toBe(false);
  });
});
