// ru-code (mid-turn wave, P3c): the balloon mark rule.
//
// Pure descriptor, so the rule is pinned without rendering. The three states the
// owner specified, plus the two "render nothing" cases — which are the ones
// most likely to regress, because they are the invisible default.
import { describe, expect, it } from "vite-plus/test";

import { midTurnDeliveryMark } from "../../composer/midTurnDeliveryMark";

describe("midTurnDeliveryMark", () => {
  it("pending renders the clock", () => {
    const mark = midTurnDeliveryMark("pending");
    expect(mark?.icon).toBe("clock");
    expect(mark?.label).not.toBe("");
  });

  it("not-delivered renders the alert", () => {
    const mark = midTurnDeliveryMark("not-delivered");
    expect(mark?.icon).toBe("alert-circle");
    expect(mark?.label).not.toBe("");
  });

  it("delivered renders NOTHING — a delivered message is just a message", () => {
    // Not a tick. Adding one would put a novel marker on the overwhelmingly
    // common case to communicate the absence of a problem.
    expect(midTurnDeliveryMark("delivered")).toBeNull();
  });

  it("an ordinary message (no state) renders NOTHING", () => {
    // The invisible default, and the case every existing message in every
    // thread falls into.
    expect(midTurnDeliveryMark(undefined)).toBeNull();
  });

  it("every mark carries a distinct icon and an accessible label", () => {
    const pending = midTurnDeliveryMark("pending");
    const notDelivered = midTurnDeliveryMark("not-delivered");
    expect(pending?.icon).not.toBe(notDelivered?.icon);
    expect(pending?.label).not.toBe(notDelivered?.label);
    // Colour must differentiate too: the not-delivered state is the only one
    // that signals a problem.
    expect(pending?.className).not.toBe(notDelivered?.className);
  });
});
