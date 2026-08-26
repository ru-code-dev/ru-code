// ru-code (mid-turn wave, phase 4 — m4/SB4): the STICKINESS rule.
//
// Phase 2 shipped a fold with these exact semantics (D1-D9) and phase 3b then
// chose a persisted last-writer-wins column instead, leaving the fold unwired —
// 9 specs pinning a function nothing called, while the rule they described was
// NOT enforced anywhere. The adversary was right; the fold has been deleted and
// the rule now lives once, in contracts, used by BOTH the server's projection
// merge (the copy a reload reads) and the client reducer (the copy the live
// balloon reads).
import { mergeMidTurnDeliveryState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

describe("mergeMidTurnDeliveryState", () => {
  it("takes the incoming mark when nothing is stored", () => {
    expect(mergeMidTurnDeliveryState(undefined, "pending")).toBe("pending");
  });

  it("moves a PENDING mark — it is the only movable state", () => {
    expect(mergeMidTurnDeliveryState("pending", "delivered")).toBe("delivered");
    expect(mergeMidTurnDeliveryState("pending", "not-delivered")).toBe("not-delivered");
  });

  it("DELIVERED is sticky — a late reset must never un-deliver a sent message", () => {
    // The model already saw this text. Re-marking it would be a lie about what
    // the agent was told, which is worse than showing no mark at all.
    expect(mergeMidTurnDeliveryState("delivered", "not-delivered")).toBe("delivered");
    expect(mergeMidTurnDeliveryState("delivered", "pending")).toBe("delivered");
  });

  it("NOT-DELIVERED is sticky — nothing auto-fires after a stop", () => {
    // A stray late drain cannot resurrect a message the user was told failed.
    expect(mergeMidTurnDeliveryState("not-delivered", "delivered")).toBe("not-delivered");
    expect(mergeMidTurnDeliveryState("not-delivered", "pending")).toBe("not-delivered");
  });

  it("an absent incoming mark never erases a stored one", () => {
    // The ordinary re-emission path (`text: ""`, no deliveryState) must leave an
    // existing mark alone — the same rule the SQL COALESCE enforces one layer
    // down.
    expect(mergeMidTurnDeliveryState("pending", undefined)).toBe("pending");
    expect(mergeMidTurnDeliveryState("delivered", undefined)).toBe("delivered");
    expect(mergeMidTurnDeliveryState(undefined, undefined)).toBeUndefined();
  });

  it("is idempotent — at-least-once delivery of a signal changes nothing", () => {
    expect(mergeMidTurnDeliveryState("delivered", "delivered")).toBe("delivered");
    expect(mergeMidTurnDeliveryState("not-delivered", "not-delivered")).toBe("not-delivered");
  });
});
