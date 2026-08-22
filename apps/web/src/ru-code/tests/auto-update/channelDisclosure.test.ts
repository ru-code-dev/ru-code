// ru-code: the source card's disclosure rule. The owner's words: the block is open when there is a
// real problem, or when the user opened it — a clean check must never touch it.
//
// The reported behaviour was the opposite: press «Проверить» with zero errors → the block expands →
// the check succeeds → it collapses on its own. Two separate defects produced that, and this file
// pins both of them shut.

import { describe, expect, it } from "vite-plus/test";

import {
  isDisclosureOpen,
  needsAttention,
  settleHealth,
} from "../../auto-update-ui/ui-kit/custom/channelDisclosure";
import type { ChannelHealth } from "../../auto-update-ui/model";

const ALL_HEALTHS: ReadonlyArray<ChannelHealth> = [
  "ok",
  "probing",
  "unchecked",
  "needs-setup",
  "unreachable",
];

describe("settleHealth", () => {
  // `probing` is the request, not its answer. Letting it through would collapse a card that is open
  // precisely because its source is broken, for the duration of every check.
  it("keeps the previous verdict while a request is in flight", () => {
    for (const previous of ALL_HEALTHS) {
      expect(settleHealth(previous, "probing")).toBe(previous);
    }
  });

  it("takes every other health as the new verdict", () => {
    for (const incoming of ALL_HEALTHS.filter((health) => health !== "probing")) {
      expect(settleHealth("ok", incoming)).toBe(incoming);
      expect(settleHealth("unreachable", incoming)).toBe(incoming);
    }
  });
});

describe("needsAttention", () => {
  it("is true for exactly the two problem verdicts", () => {
    for (const settledHealth of ALL_HEALTHS) {
      expect(needsAttention({ enabled: true, settledHealth })).toBe(
        settledHealth === "needs-setup" || settledHealth === "unreachable",
      );
    }
  });

  // A successful check must leave the block alone — this is the reported bug, stated directly.
  it("is false for a clean check, in flight and after it settles", () => {
    expect(needsAttention({ enabled: true, settledHealth: "probing" })).toBe(false);
    expect(needsAttention({ enabled: true, settledHealth: "ok" })).toBe(false);
  });

  it("is false for a disabled source whatever its last verdict was", () => {
    for (const settledHealth of ALL_HEALTHS) {
      expect(needsAttention({ enabled: false, settledHealth })).toBe(false);
    }
  });
});

describe("isDisclosureOpen", () => {
  // The old code took `open` as a mount snapshot, so the answer depended on WHEN the card was
  // built. As a derivation the same inputs always give the same answer — which is what makes a
  // remount invisible instead of a spontaneous open-then-close.
  it("follows attention until the user has an opinion", () => {
    expect(isDisclosureOpen({ userSet: null, attention: false })).toBe(false);
    expect(isDisclosureOpen({ userSet: null, attention: true })).toBe(true);
  });

  it("lets the user's choice win over the state in both directions", () => {
    // Opened by hand on a healthy source: stays open.
    expect(isDisclosureOpen({ userSet: true, attention: false })).toBe(true);
    // Closed by hand despite a problem: stays closed — never re-opens under them.
    expect(isDisclosureOpen({ userSet: false, attention: true })).toBe(false);
  });

  // The card CAN now open when a source breaks after mount — the old snapshot could not.
  it("opens when a problem appears later", () => {
    const untouched = null;
    expect(isDisclosureOpen({ userSet: untouched, attention: false })).toBe(false);
    expect(isDisclosureOpen({ userSet: untouched, attention: true })).toBe(true);
  });
});

describe("the reported sequence: press «Проверить» on a healthy source", () => {
  // idle → probing → ok. The block must not move at any point.
  it("never opens the block", () => {
    let settled: ChannelHealth = "ok";
    const userSet = null;
    const openAt = (incoming: ChannelHealth): boolean => {
      settled = settleHealth(settled, incoming);
      return isDisclosureOpen({
        userSet,
        attention: needsAttention({ enabled: true, settledHealth: settled }),
      });
    };

    expect(openAt("ok")).toBe(false);
    expect(openAt("probing")).toBe(false);
    expect(openAt("ok")).toBe(false);
  });

  // The other half: a check that FAILS opens it, and it stays open while the next check runs.
  it("opens on a failure and does not flicker during the next check", () => {
    let settled: ChannelHealth = "ok";
    const openAt = (incoming: ChannelHealth): boolean => {
      settled = settleHealth(settled, incoming);
      return isDisclosureOpen({
        userSet: null,
        attention: needsAttention({ enabled: true, settledHealth: settled }),
      });
    };

    expect(openAt("probing")).toBe(false);
    expect(openAt("unreachable")).toBe(true);
    // Re-check: still open throughout, because `probing` carries no verdict.
    expect(openAt("probing")).toBe(true);
    expect(openAt("ok")).toBe(false);
  });
});
