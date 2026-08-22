// ru-code: the catch-up gap decision (boot-performance.md S1) — replay for small
// gaps, the cold snapshot frame for stale cursors.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CATCH_UP_GAP_THRESHOLD, decideCatchUpPlan } from "../../reconnect/catchUpPolicy.ts";

describe("decideCatchUpPlan", () => {
  it.effect("replays at and below the threshold, snapshots above it", () =>
    Effect.gen(function* () {
      const at = yield* decideCatchUpPlan({
        endpoint: "test",
        afterSequence: 100,
        currentSequence: 100 + CATCH_UP_GAP_THRESHOLD,
      });
      expect(at).toBe("replay");

      const above = yield* decideCatchUpPlan({
        endpoint: "test",
        afterSequence: 100,
        currentSequence: 100 + CATCH_UP_GAP_THRESHOLD + 1,
      });
      expect(above).toBe("snapshot");
    }),
  );

  it.effect("a fresh cursor (zero gap) always replays", () =>
    Effect.gen(function* () {
      const plan = yield* decideCatchUpPlan({
        endpoint: "test",
        afterSequence: 42,
        currentSequence: 42,
      });
      expect(plan).toBe("replay");
    }),
  );
});
