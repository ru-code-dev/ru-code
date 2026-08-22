// ru-code: the pure tick scheduler (engine/schedule.ts). Window edges
// (07:59 / 08:00 / 17:xx / 17:59), jitter determinism, and DST-safety by
// construction — every `now` and every expected instant is built from LOCAL
// wall-clock components, so the assertions hold in any host timezone.
// @effect-diagnostics globalDate:off

import { describe, expect, it } from "@effect/vitest";

import { UPDATE_WORK_HOURS } from "@ru-code/branding";

import { nextTickAt } from "../../auto-update/engine/schedule.ts";

/** A local wall-clock instant (epoch ms) — the same construction the scheduler uses internally. */
function localMs(year: number, month0: number, day: number, hour: number, minute: number): number {
  return new Date(year, month0, day, hour, minute, 0, 0).getTime();
}

function at(hour: number, minute: number): number {
  return new Date(2026, 5, 15, hour, minute, 0, 0).getTime();
}

function expectedTick(dayOffset: number, hour: number, minute: number): number {
  return new Date(2026, 5, 15 + dayOffset, hour, minute, 0, 0).getTime();
}

describe("UPDATE_WORK_HOURS", () => {
  it("is 08..17 inclusive", () => {
    expect(UPDATE_WORK_HOURS.first).toBe(8);
    expect(UPDATE_WORK_HOURS.last).toBe(17);
  });
});

describe("nextTickAt — window edges", () => {
  it("07:59 → today 08:jitter", () => {
    expect(nextTickAt(at(7, 59), 0)).toBe(expectedTick(0, 8, 0));
    expect(nextTickAt(at(7, 59), 15)).toBe(expectedTick(0, 8, 15));
  });

  it("before dawn (03:00) → today 08:jitter", () => {
    expect(nextTickAt(at(3, 0), 30)).toBe(expectedTick(0, 8, 30));
  });

  it("exactly 08:00 with jitter 0 → 09:00 (strictly after now)", () => {
    expect(nextTickAt(at(8, 0), 0)).toBe(expectedTick(0, 9, 0));
  });

  it("08:00 with jitter 30 → 08:30 today", () => {
    expect(nextTickAt(at(8, 0), 30)).toBe(expectedTick(0, 8, 30));
  });

  it("mid-window 16:30 jitter 15 → 17:15 today", () => {
    expect(nextTickAt(at(16, 30), 15)).toBe(expectedTick(0, 17, 15));
  });

  it("17:10 jitter 15 → 17:15 today (last in-window tick)", () => {
    expect(nextTickAt(at(17, 10), 15)).toBe(expectedTick(0, 17, 15));
  });

  it("17:30 jitter 15 → tomorrow 08:15 (window spent)", () => {
    expect(nextTickAt(at(17, 30), 15)).toBe(expectedTick(1, 8, 15));
  });

  it("17:59 → tomorrow 08:jitter", () => {
    expect(nextTickAt(at(17, 59), 0)).toBe(expectedTick(1, 8, 0));
    expect(nextTickAt(at(17, 59), 45)).toBe(expectedTick(1, 8, 45));
  });

  it("late evening (22:00) → tomorrow 08:jitter", () => {
    expect(nextTickAt(at(22, 0), 5)).toBe(expectedTick(1, 8, 5));
  });
});

describe("nextTickAt — jitter", () => {
  it("respects the exact jitter minute at every in-window hour", () => {
    for (let hour = 8; hour <= 16; hour += 1) {
      // now = HH:00 → next tick is the SAME hour at :20 (20 > 0).
      expect(nextTickAt(at(hour, 0), 20)).toBe(expectedTick(0, hour, 20));
    }
  });

  it("clamps an out-of-range jitter defensively", () => {
    expect(nextTickAt(at(7, 0), 75)).toBe(expectedTick(0, 8, 59));
    expect(nextTickAt(at(7, 0), -5)).toBe(expectedTick(0, 8, 0));
  });

  it("rolls to the next hour when now is past this hour's jitter", () => {
    // 09:30 with jitter 15 → 09:15 already passed → 10:15.
    expect(nextTickAt(at(9, 30), 15)).toBe(expectedTick(0, 10, 15));
  });
});

describe("DST-safe by construction", () => {
  it("returns an instant equal to the locally-constructed wall-clock tick", () => {
    // Whatever the host TZ (and whether or not a DST transition sits between now
    // and the tick), the epoch is derived from local components on both sides, so
    // the scheduler and the expectation agree.
    const now = localMs(2026, 2, 8, 6, 0); // a US spring-forward morning
    expect(nextTickAt(now, 10)).toBe(new Date(2026, 2, 8, 8, 10, 0, 0).getTime());
  });
});
