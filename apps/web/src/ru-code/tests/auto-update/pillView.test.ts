// ru-code: unit tests for the v3 auto-update pill view logic — the two kinds
// (release / problems), the server-owned release re-raise, and the client-owned
// problem re-raise (both fixed 2h, W8).
import { describe, expect, it } from "vite-plus/test";

import { computePillView, type PillInput } from "../../auto-update-ui/notify/pillView";
import { UPDATE_NOTIFY_RERAISE_MS } from "@ru-code/branding";

import { type ProblemSignal, type SourceSignal } from "../../auto-update-ui/notify/notifyDecision";

const NOW = 1_800_000_000_000;

const okSource: SourceSignal = {
  offered: true,
  enabled: true,
  delivered: true,
  paused: false,
  answeredFail: false,
  transportStreak: 0,
};

const pausedSource: SourceSignal = { ...okSource, delivered: false, paused: true };

/** Both sources healthy → no problem. */
const noProblem: ProblemSignal = { git: okSource, web: okSource, muted: false, stamp: null };

/** git paused (actionable) + web unreachable (not delivered) → problem. */
const activeProblem: ProblemSignal = {
  git: pausedSource,
  web: { ...okSource, delivered: false, transportStreak: 5 },
  muted: false,
  stamp: null,
};

function input(overrides: Partial<PillInput>): PillInput {
  return {
    release: { available: false, version: null, muted: false, stamp: null },
    problem: noProblem,
    runActive: false,
    runTargetVersion: null,
    runRestarting: false,
    ...overrides,
  };
}

describe("computePillView — release", () => {
  const available = { available: true, version: "1.4.2", muted: false, stamp: null };

  it("shows the release pill for an available version", () => {
    const view = computePillView(input({ release: available }), NOW);
    expect(view?.kind).toBe("release");
    expect(view?.tone).toBe("available");
    expect(view?.title).toContain("1.4.2");
    expect(view?.version).toBe("1.4.2");
    // A status indicator, not a nag: there is nothing to dismiss.
    expect(view?.dismissible).toBe(false);
  });

  // The stamp is written the moment the TOAST fires. If the pill honoured it, the sidebar would go
  // blank for two hours while an update sits waiting — so the indicator ignores it by design.
  it("keeps showing while the toast's quiet window is open", () => {
    const view = computePillView(
      input({ release: { ...available, stamp: { version: "1.4.2", at: NOW - 60_000 } } }),
      NOW,
    );
    expect(view?.kind).toBe("release");
  });

  it("keeps showing after the quiet window elapses", () => {
    const view = computePillView(
      input({
        release: {
          ...available,
          stamp: { version: "1.4.2", at: NOW - UPDATE_NOTIFY_RERAISE_MS - 1 },
        },
      }),
      NOW,
    );
    expect(view?.kind).toBe("release");
  });

  it("disappears when the release is gone", () => {
    expect(computePillView(input({ release: { ...available, available: false } }), NOW)).toBeNull();
  });

  it("hides a muted release", () => {
    expect(computePillView(input({ release: { ...available, muted: true } }), NOW)).toBeNull();
  });
});

describe("computePillView — problems", () => {
  it("shows the problems pill when a source is actionable and none delivered", () => {
    const view = computePillView(input({ problem: activeProblem }), NOW);
    expect(view?.kind).toBe("problems");
    expect(view?.tone).toBe("attention");
    expect(view?.dismissible).toBe(true);
  });

  it("hides problems when muted", () => {
    expect(computePillView(input({ problem: { ...activeProblem, muted: true } }), NOW)).toBeNull();
  });

  it("hides problems stamped within the server 2h window, re-raises after", () => {
    expect(
      computePillView(input({ problem: { ...activeProblem, stamp: { at: NOW - 60_000 } } }), NOW),
    ).toBeNull();
    expect(
      computePillView(
        input({ problem: { ...activeProblem, stamp: { at: NOW - UPDATE_NOTIFY_RERAISE_MS - 1 } } }),
        NOW,
      )?.kind,
    ).toBe("problems");
  });

  it("stays silent when a source works behind a broken one", () => {
    const gitBrokenWebOk: ProblemSignal = {
      git: { ...okSource, delivered: false, answeredFail: true },
      web: okSource,
      muted: false,
      stamp: null,
    };
    expect(computePillView(input({ problem: gitBrokenWebOk }), NOW)).toBeNull();
  });
});

describe("computePillView — precedence & silence", () => {
  it("release wins over a concurrent problem", () => {
    const view = computePillView(
      input({
        release: { available: true, version: "1.4.2", muted: false, stamp: null },
        problem: activeProblem,
      }),
      NOW,
    );
    expect(view?.kind).toBe("release");
  });

  // It used to return null here, so the ONE moment something is actually happening was the one
  // moment the sidebar said nothing — navigate away from the settings page mid-update and the
  // update became invisible. `updating` outranks release and problems while it lasts.
  it("shows the updating pill while a run is live, outranking the release pill", () => {
    const view = computePillView(
      input({
        release: { available: true, version: "1.4.2", muted: false, stamp: null },
        problem: activeProblem,
        runActive: true,
        runTargetVersion: "1.4.2",
      }),
      NOW,
    );
    expect(view?.kind).toBe("updating");
    expect(view?.title).toContain("1.4.2");
    expect(view?.version).toBe("1.4.2");
    // A status indicator, never a nag.
    expect(view?.dismissible).toBe(false);
  });

  it("names the restart phase, so the blind window is not a mystery either", () => {
    const view = computePillView(
      input({ runActive: true, runTargetVersion: "1.4.2", runRestarting: true }),
      NOW,
    );
    expect(view?.kind).toBe("updating");
    expect(view?.title).not.toContain("1.4.2");
    expect(view?.description.length).toBeGreaterThan(0);
  });

  it("shows nothing when up-to-date with no problem", () => {
    expect(computePillView(input({}), NOW)).toBeNull();
  });
});
