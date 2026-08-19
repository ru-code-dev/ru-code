// ru-code: unit pin for the item→turn attribution decision (the composite the
// adapter wires — turnAttributionWire.e2e.test.ts proves the wiring over the
// fake ACP agent; this file holds the decision table itself).
import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import {
  attributeItemCompleted,
  attributeItemDelta,
  attributeItemStarted,
} from "../../qwen/itemTurnAttribution.ts";

const TURN_1 = TurnId.make("11111111-1111-4111-8111-111111111111");
const TURN_2 = TurnId.make("22222222-2222-4222-8222-222222222222");
const ITEM = "assistant:session:r1:segment:0";

describe("itemTurnAttribution", () => {
  it("pins the active turn at item start and returns it at completion after the turn cleared", () => {
    const itemTurnIds = new Map<string, TurnId>();
    const started = attributeItemStarted(
      itemTurnIds,
      { activeTurnId: TURN_1, lastTurnId: TURN_1, hiddenCompressActive: false },
      ITEM,
    );
    expect(started).toBe(TURN_1);
    // The live disease: completion consumed after the finalizer cleared the
    // active marker — the pin must win.
    const completed = attributeItemCompleted(
      itemTurnIds,
      { activeTurnId: undefined, lastTurnId: TURN_1, hiddenCompressActive: false },
      ITEM,
    );
    expect(completed).toBe(TURN_1);
    expect(itemTurnIds.size).toBe(0); // released
  });

  it("keeps the ORIGINAL turn when completion is consumed under the NEXT turn (no cross-turn bleed)", () => {
    const itemTurnIds = new Map<string, TurnId>();
    attributeItemStarted(
      itemTurnIds,
      { activeTurnId: TURN_1, lastTurnId: TURN_1, hiddenCompressActive: false },
      ITEM,
    );
    const completed = attributeItemCompleted(
      itemTurnIds,
      { activeTurnId: TURN_2, lastTurnId: TURN_2, hiddenCompressActive: false },
      ITEM,
    );
    expect(completed).toBe(TURN_1);
  });

  it("attributes an item that starts AFTER the turn settled to the turn that just ended", () => {
    const itemTurnIds = new Map<string, TurnId>();
    const started = attributeItemStarted(
      itemTurnIds,
      { activeTurnId: undefined, lastTurnId: TURN_1, hiddenCompressActive: false },
      ITEM,
    );
    expect(started).toBe(TURN_1);
    expect(itemTurnIds.get(ITEM)).toBe(TURN_1);
  });

  it("never attributes hidden-compress output to the previous turn", () => {
    const itemTurnIds = new Map<string, TurnId>();
    const started = attributeItemStarted(
      itemTurnIds,
      { activeTurnId: undefined, lastTurnId: TURN_1, hiddenCompressActive: true },
      ITEM,
    );
    expect(started).toBeUndefined();
    expect(itemTurnIds.size).toBe(0);
    const completed = attributeItemCompleted(
      itemTurnIds,
      { activeTurnId: undefined, lastTurnId: TURN_1, hiddenCompressActive: true },
      ITEM,
    );
    expect(completed).toBeUndefined();
  });

  it("deltas resolve through the item pin, falling back to the active turn without one", () => {
    const itemTurnIds = new Map<string, TurnId>([[ITEM, TURN_1]]);
    expect(
      attributeItemDelta(
        itemTurnIds,
        { activeTurnId: TURN_2, lastTurnId: TURN_2, hiddenCompressActive: false },
        ITEM,
      ),
    ).toBe(TURN_1);
    expect(
      attributeItemDelta(
        itemTurnIds,
        { activeTurnId: TURN_2, lastTurnId: TURN_2, hiddenCompressActive: false },
        undefined,
      ),
    ).toBe(TURN_2);
  });
});
