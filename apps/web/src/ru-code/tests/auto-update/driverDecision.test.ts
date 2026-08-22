// ru-code: table tests for the pure auto-update notify/redirect decision core
// (notify/notifyDecision.ts). Covers the whole matrix the driver + pill share:
// muted / stamped / 2h re-raise / new-version override / problem-actionable / redirect.
import { describe, expect, it } from "vite-plus/test";

import { UPDATE_NOTIFY_RERAISE_MS } from "@ru-code/branding";

import {
  computeDriverDecision,
  hasProblem,
  problemToastKey,
  releaseToastKey,
  shouldShowRelease,
  type DriverInput,
  type ProblemSignal,
  type ReleaseSignal,
  type SourceSignal,
} from "../../auto-update-ui/notify/notifyDecision";

const NOW = 1_800_000_000_000;

const okSource: SourceSignal = {
  offered: true,
  enabled: true,
  delivered: true,
  paused: false,
  answeredFail: false,
  transportStreak: 0,
};
const source = (o: Partial<SourceSignal>): SourceSignal => ({ ...okSource, ...o });

// ── shouldShowRelease ────────────────────────────────────────────────────────

describe("shouldShowRelease", () => {
  const base: ReleaseSignal = { available: true, version: "1.4.2", muted: false, stamp: null };
  const stamped = (at: number, version = "1.4.2"): ReleaseSignal => ({
    ...base,
    stamp: { version, at },
  });
  const cases: ReadonlyArray<[string, ReleaseSignal, boolean]> = [
    ["fresh available", base, true],
    ["not available", { ...base, available: false }, false],
    ["no version", { ...base, version: null }, false],
    ["muted", { ...base, muted: true }, false],
    ["stamped within 2h", stamped(NOW - 60_000), false],
    ["stamped just under 2h", stamped(NOW - UPDATE_NOTIFY_RERAISE_MS + 1), false],
    ["stamped exactly 2h ago", stamped(NOW - UPDATE_NOTIFY_RERAISE_MS), true],
    ["stamped over 2h ago", stamped(NOW - UPDATE_NOTIFY_RERAISE_MS - 1), true],
    ["stamp names an OLDER version — the new one is news", stamped(NOW - 1, "1.4.1"), true],
  ];
  it.each(cases)("%s → %s", (_label, release, expected) => {
    expect(shouldShowRelease(release, NOW)).toBe(expected);
  });
});

// ── hasProblem (master rule) ──────────────────────────────────────────────────

describe("hasProblem", () => {
  const cases: ReadonlyArray<[string, ProblemSignal, boolean]> = [
    ["both ok", { git: okSource, web: okSource, muted: false, stamp: null }, false],
    [
      "git broken, web ok (silent)",
      {
        git: source({ delivered: false, answeredFail: true }),
        web: okSource,
        muted: false,
        stamp: null,
      },
      false,
    ],
    [
      "both transport-only, no escalation (silent)",
      {
        git: source({ delivered: false, transportStreak: 2 }),
        web: source({ delivered: false, transportStreak: 1 }),
        muted: false,
        stamp: null,
      },
      false,
    ],
    [
      "git paused, web unreachable-streak (actionable)",
      {
        git: source({ delivered: false, paused: true }),
        web: source({ delivered: false, transportStreak: 5 }),
        muted: false,
        stamp: null,
      },
      true,
    ],
    [
      "web answered-fail, git off (actionable, none delivered)",
      {
        git: source({ enabled: false, delivered: false }),
        web: source({ delivered: false, answeredFail: true }),
        muted: false,
        stamp: null,
      },
      true,
    ],
    [
      "both off (no active source — silent)",
      {
        git: source({ enabled: false, delivered: false, answeredFail: true }),
        web: source({ enabled: false, delivered: false, paused: true }),
        muted: false,
        stamp: null,
      },
      false,
    ],
    [
      "not offered actionable is ignored",
      {
        git: source({ offered: false, delivered: false, paused: true }),
        web: source({ delivered: false, transportStreak: 1 }),
        muted: false,
        stamp: null,
      },
      false,
    ],
  ];
  it.each(cases)("%s → %s", (_label, problem, expected) => {
    expect(hasProblem(problem)).toBe(expected);
  });
});

// ── releaseToastKey (dedupe window) ───────────────────────────────────────────

describe("releaseToastKey", () => {
  it("differs per quiet window so a re-raise re-fires", () => {
    expect(releaseToastKey("1.4.2", null)).toBe("1.4.2:fresh");
    expect(releaseToastKey("1.4.2", { version: "1.4.2", at: 123 })).toBe("1.4.2:123");
    expect(releaseToastKey("1.4.2", null)).not.toBe(
      releaseToastKey("1.4.2", { version: "1.4.2", at: 123 }),
    );
  });

  it("a stamp about another version does not dedupe this one", () => {
    expect(releaseToastKey("1.4.2", { version: "1.4.1", at: 123 })).toBe("1.4.2:fresh");
  });
});

// ── problemToastKey ───────────────────────────────────────────────────────────
//
// The counterpart guard, and the one that was missing. `computeDriverDecision` is recomputed on the
// shared one-second tick (deliberately — that is what expires a quiet window without a reload), so
// an eligible problem notice with no local key produced a NEW toast every second. The stamp that
// was supposed to stop it is a server write, and a problem notice is raised precisely when the
// server may be unreachable, so it is exactly the case where the write cannot land.
describe("problemToastKey", () => {
  it("is stable while the stamp is, so a re-decided notice does not re-fire", () => {
    expect(problemToastKey(null)).toBe(problemToastKey(null));
    expect(problemToastKey({ at: 123 })).toBe(problemToastKey({ at: 123 }));
  });

  it("rotates with the stamp, so the next quiet window is free to raise again", () => {
    expect(problemToastKey(null)).not.toBe(problemToastKey({ at: 123 }));
    expect(problemToastKey({ at: 123 })).not.toBe(problemToastKey({ at: 456 }));
  });

  // The storm shape, replayed: the notice stays eligible (nothing changed server-side, because the
  // server is gone) while the decision is recomputed once a second for ten seconds.
  it("collapses ten seconds of an unchanged eligible notice to ONE raise", () => {
    const problem: ProblemSignal = {
      git: source({ delivered: false, paused: true }),
      web: source({ delivered: false, transportStreak: 5 }),
      muted: false,
      stamp: null, // the snooze RPC never landed — the server is unreachable
    };
    const fired = new Set<string>();
    let raises = 0;
    for (let second = 0; second < 10; second += 1) {
      const decision = computeDriverDecision({
        release: { available: false, version: null, muted: false, stamp: null },
        problem,
        runActive: false,
        onUpdateSettingsRoute: false,
        now: NOW + second * 1_000,
      });
      expect(decision.problemToast).toBe(true); // still eligible every single tick
      const key = problemToastKey(problem.stamp);
      if (!fired.has(key)) {
        fired.add(key);
        raises += 1;
      }
    }
    expect(raises).toBe(1);
  });
});

// ── computeDriverDecision (whole matrix) ──────────────────────────────────────

describe("computeDriverDecision", () => {
  const available: ReleaseSignal = { available: true, version: "1.4.2", muted: false, stamp: null };
  const problemY: ProblemSignal = {
    git: source({ delivered: false, paused: true }),
    web: source({ delivered: false, transportStreak: 5 }),
    muted: false,
    stamp: null,
  };
  const problemN: ProblemSignal = { git: okSource, web: okSource, muted: false, stamp: null };

  function input(o: Partial<DriverInput>): DriverInput {
    return {
      release: { available: false, version: null, muted: false, stamp: null },
      problem: problemN,
      runActive: false,
      onUpdateSettingsRoute: false,
      now: NOW,
      ...o,
    };
  }

  it("raises the release toast for an eligible version", () => {
    expect(computeDriverDecision(input({ release: available })).releaseToast).toBe("1.4.2");
  });

  it("suppresses the release toast when muted / stamped within 2h", () => {
    expect(
      computeDriverDecision(input({ release: { ...available, muted: true } })).releaseToast,
    ).toBeNull();
    expect(
      computeDriverDecision(
        input({ release: { ...available, stamp: { version: "1.4.2", at: NOW - 60_000 } } }),
      ).releaseToast,
    ).toBeNull();
  });

  it("raises the problem toast when actionable and past the server 2h stamp", () => {
    expect(computeDriverDecision(input({ problem: problemY })).problemToast).toBe(true);
    expect(
      computeDriverDecision(input({ problem: { ...problemY, stamp: { at: NOW - 60_000 } } }))
        .problemToast,
    ).toBe(false);
    expect(
      computeDriverDecision(
        input({ problem: { ...problemY, stamp: { at: NOW - UPDATE_NOTIFY_RERAISE_MS - 1 } } }),
      ).problemToast,
    ).toBe(true);
  });

  it("suppresses the problem toast when muted", () => {
    expect(
      computeDriverDecision(input({ problem: { ...problemY, muted: true } })).problemToast,
    ).toBe(false);
  });

  it("suppresses BOTH toasts while a run is active (the hero IS the run view)", () => {
    const decision = computeDriverDecision(
      input({ release: available, problem: problemY, runActive: true }),
    );
    expect(decision.releaseToast).toBeNull();
    expect(decision.problemToast).toBe(false);
  });

  // F15: the update-settings page already states everything a toast would — a press there must not
  // also produce a notification on top of the page the user is looking at.
  it("suppresses BOTH toasts on the update-settings route", () => {
    const decision = computeDriverDecision(
      input({ release: available, problem: problemY, onUpdateSettingsRoute: true }),
    );
    expect(decision.releaseToast).toBeNull();
    expect(decision.problemToast).toBe(false);
  });

  it("still raises them on any other route", () => {
    expect(
      computeDriverDecision(input({ release: available, onUpdateSettingsRoute: false }))
        .releaseToast,
    ).toBe("1.4.2");
  });
});
