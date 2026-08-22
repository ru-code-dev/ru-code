// ru-code: the PURE auto-update state machine (engine/transitions.ts). Table-driven
// coverage of every invariant: the answered-auth pause counter, the transport
// streak + failingSince, git-over-web winner selection, release clearing/dismissal
// reset, bounded history, the full hero-derivation matrix (to-do §3), the
// the run lifecycle (incl. pct dedupe), the
// checkNow-during-run no-op, and the toggle/autoCheck scheduling.

import { describe, expect, it } from "@effect/vitest";

import { UPDATE_HISTORY_ROWS } from "@ru-code/branding";

import type {
  AutoUpdateWireState,
  AvailableReleaseWire,
  GitSourceWire,
  SshCredMeta,
  UserPassCredMeta,
  WebSourceWire,
} from "@t3tools/contracts";

import {
  advanceRunPhase,
  appendRunLogLine,
  applySourceResult,
  applyTickRound,
  canCheckNow,
  checkAborted,
  probeStarted,
  probeStopped,
  scheduleBeatDecision,
  checkStarted,
  failUnfinishedRun,
  isRunUnfinished,
  credentialsSaved,
  currentAvailableRelease,
  deriveHero,
  markNotified,
  setPressRefusal,
  failRun,
  setAutoCheck,
  setNotifyPrefs,
  setRunPct,
  startRun,
  toggleSource,
  type HeroSourceView,
  type SourceResult,
  type TickSourceOutcome,
  applyProbeResult,
} from "../../auto-update/engine/transitions.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

function gitSource(over: Partial<GitSourceWire> = {}): GitSourceWire {
  return {
    enabled: true,
    offered: true,
    url: "git-url",
    paused: false,
    authFails: 0,
    transportStreak: 0,
    failingSince: null,
    lastResult: null,
    probing: false,
    authVia: "ambient",
    httpsCred: null,
    sshCred: null,
    ...over,
  };
}

function webSource(over: Partial<WebSourceWire> = {}): WebSourceWire {
  return {
    enabled: true,
    offered: true,
    url: "web-url",
    paused: false,
    authFails: 0,
    transportStreak: 0,
    failingSince: null,
    lastResult: null,
    probing: false,
    cred: null,
    ...over,
  };
}

function makeState(over: Partial<AutoUpdateWireState> = {}): AutoUpdateWireState {
  return {
    currentVersion: "1.0.0",
    facts: {
      installDir: "/i",
      entryJs: "/i/cli.js",
      pid: 1,
      port: 8080,
      address: "127.0.0.1:8080",
      canApply: true,
      blockReason: null,
    },
    autoCheck: true,
    nextCheckAt: null,
    git: gitSource(),
    web: webSource(),
    status: { phase: "never-checked" },
    history: [],
    run: null,
    lastApply: null,
    notify: { releasesMuted: false, problemsMuted: false },
    notified: { release: null, problems: null },
    pressRefusal: null,
    ...over,
  };
}

function release(version: string, over: Partial<AvailableReleaseWire> = {}): AvailableReleaseWire {
  return {
    version,
    releasedAt: null,
    sizeBytes: null,
    sha256: `sha-${version}`,
    changelog: [],
    changelogTruncated: false,
    foundAt: 0,
    ...over,
  };
}

const okResult: SourceResult = { outcome: "ok", latencyMs: 10, raw: "200 OK" };
const failTransport = (code: "dns" | "timeout" | "reset"): SourceResult => ({
  outcome: "fail",
  class: "transport",
  code,
  latencyMs: null,
  raw: code,
});

// ── applySourceResult: answered-auth pause counter ───────────────────────────

describe("applySourceResult — answered-auth pause counter", () => {
  const authFailWeb: SourceResult = {
    outcome: "fail",
    class: "answered",
    code: "http-401",
    latencyMs: null,
    raw: "401",
  };
  const authFailGit: SourceResult = {
    outcome: "fail",
    class: "answered",
    code: "git-access-denied",
    latencyMs: null,
    raw: "denied",
  };

  it("web: one auth failure does not pause", () => {
    const next = applySourceResult(makeState(), "web", authFailWeb, 100);
    expect(next.web.authFails).toBe(1);
    expect(next.web.paused).toBe(false);
  });

  it("web: two auth failures pause", () => {
    let s = applySourceResult(makeState(), "web", authFailWeb, 100);
    s = applySourceResult(s, "web", authFailWeb, 200);
    expect(s.web.authFails).toBe(2);
    expect(s.web.paused).toBe(true);
  });

  it("git: two access-denied failures pause git", () => {
    let s = applySourceResult(makeState(), "git", authFailGit, 100);
    s = applySourceResult(s, "git", authFailGit, 200);
    expect(s.git.authFails).toBe(2);
    expect(s.git.paused).toBe(true);
  });

  it("an OK result clears the pause and the auth counter (manual-probe unpause path)", () => {
    let s = applySourceResult(makeState(), "web", authFailWeb, 100);
    s = applySourceResult(s, "web", authFailWeb, 200);
    expect(s.web.paused).toBe(true);
    s = applySourceResult(s, "web", okResult, 300);
    expect(s.web.paused).toBe(false);
    expect(s.web.authFails).toBe(0);
    expect(s.web.lastResult).toEqual({ outcome: "ok", at: 300, latencyMs: 10, raw: "200 OK" });
  });

  it("a non-auth answered failure records but never pauses", () => {
    const notFound: SourceResult = {
      outcome: "fail",
      class: "answered",
      code: "http-404",
      latencyMs: null,
      raw: "404",
    };
    const next = applySourceResult(makeState(), "web", notFound, 100);
    expect(next.web.authFails).toBe(0);
    expect(next.web.paused).toBe(false);
    expect(next.web.lastResult?.outcome).toBe("fail");
  });

  it("never touches `enabled` (INV-1)", () => {
    const start = makeState({
      git: gitSource({ enabled: true }),
      web: webSource({ enabled: false }),
    });
    const next = applySourceResult(start, "web", authFailWeb, 100);
    expect(next.web.enabled).toBe(false);
    expect(next.git.enabled).toBe(true);
  });
});

// ── applySourceResult: transport streak + failingSince ───────────────────────

describe("applySourceResult — transport streak + failingSince", () => {
  it("grows the streak and stamps failingSince at the first failure", () => {
    const next = applySourceResult(makeState(), "web", failTransport("dns"), 100);
    expect(next.web.transportStreak).toBe(1);
    expect(next.web.failingSince).toBe(100);
  });

  it("keeps the original failingSince across a growing streak (min of existing, now)", () => {
    let s = applySourceResult(makeState(), "web", failTransport("dns"), 100);
    s = applySourceResult(s, "web", failTransport("timeout"), 250);
    expect(s.web.transportStreak).toBe(2);
    expect(s.web.failingSince).toBe(100);
  });

  it("an OK result resets the streak and failingSince", () => {
    let s = applySourceResult(makeState(), "web", failTransport("dns"), 100);
    s = applySourceResult(s, "web", failTransport("reset"), 200);
    s = applySourceResult(s, "web", okResult, 300);
    expect(s.web.transportStreak).toBe(0);
    expect(s.web.failingSince).toBe(null);
  });

  it("an answered result clears the transport streak (transport completed)", () => {
    let s = applySourceResult(makeState(), "web", failTransport("dns"), 100);
    s = applySourceResult(
      s,
      "web",
      { outcome: "fail", class: "answered", code: "http-404", latencyMs: null, raw: "404" },
      200,
    );
    expect(s.web.transportStreak).toBe(0);
  });

  it("records on a paused source (the pure fn never refuses; the engine gates probing)", () => {
    const start = makeState({ web: webSource({ paused: true, transportStreak: 2 }) });
    const next = applySourceResult(start, "web", failTransport("timeout"), 500);
    expect(next.web.paused).toBe(true);
    expect(next.web.transportStreak).toBe(3);
    expect(next.web.lastResult?.outcome).toBe("fail");
  });
});

// ── applyTickRound: winner, clearing, dismissal reset, history ───────────────

describe("applyTickRound — winner (git before web)", () => {
  it("git OK with a newer manifest wins over web's newer manifest", () => {
    const outcomes: ReadonlyArray<TickSourceOutcome> = [
      { kind: "git", result: okResult, release: release("2.0.0") },
      { kind: "web", result: okResult, release: release("3.0.0") },
    ];
    const next = applyTickRound(makeState(), outcomes, 1000, null);
    expect(next.status).toEqual({
      phase: "available",
      release: release("2.0.0", { foundAt: 1000 }),
    });
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
  });

  it("git OK-but-up-to-date clears any prior release even if web found one (git is authoritative)", () => {
    const start = makeState({
      status: { phase: "available", release: release("2.0.0", { foundAt: 500 }) },
    });
    const outcomes: ReadonlyArray<TickSourceOutcome> = [
      { kind: "git", result: okResult, release: null },
      { kind: "web", result: okResult, release: release("3.0.0") },
    ];
    const next = applyTickRound(start, outcomes, 1000, currentAvailableRelease(start));
    expect(currentAvailableRelease(next)).toBe(null);
    expect(next.status.phase).toBe("up-to-date");
  });

  it("web wins when git failed this round", () => {
    const outcomes: ReadonlyArray<TickSourceOutcome> = [
      { kind: "git", result: failTransport("timeout"), release: null },
      { kind: "web", result: okResult, release: release("2.0.0") },
    ];
    const next = applyTickRound(makeState(), outcomes, 1000, null);
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
  });
});

describe("applyTickRound — release clearing & dismissal", () => {
  it("a found version <= current clears the release and shows up-to-date", () => {
    const start = makeState({ status: { phase: "available", release: release("2.0.0") } });
    const outcomes: ReadonlyArray<TickSourceOutcome> = [
      { kind: "git", result: okResult, release: release("1.0.0") },
    ];
    const next = applyTickRound(start, outcomes, 1000, currentAvailableRelease(start));
    expect(currentAvailableRelease(next)).toBe(null);
    expect(next.status).toEqual({ phase: "up-to-date", lastCheckedAt: 1000 });
  });

  it("a NEW version clears the release stamp so it is announced at once", () => {
    const start = makeState({
      status: { phase: "available", release: release("2.0.0", { foundAt: 100 }) },
      notified: { release: { version: "2.0.0", at: 500 }, problems: { at: 400 } },
    });
    const next = applyTickRound(
      start,
      [{ kind: "git", result: okResult, release: release("3.0.0") }],
      2000,
      currentAvailableRelease(start),
    );
    expect(currentAvailableRelease(next)?.version).toBe("3.0.0");
    expect(currentAvailableRelease(next)?.foundAt).toBe(2000);
    expect(next.notified.release).toBe(null);
    // The problems clock is independent — a new release must not un-quiet it.
    expect(next.notified.problems).toEqual({ at: 400 });
  });

  it("the SAME version keeps its foundAt and its quiet stamp", () => {
    const start = makeState({
      status: { phase: "available", release: release("2.0.0", { foundAt: 100 }) },
      notified: { release: { version: "2.0.0", at: 500 }, problems: null },
    });
    const next = applyTickRound(
      start,
      [{ kind: "git", result: okResult, release: release("2.0.0") }],
      2000,
      currentAvailableRelease(start),
    );
    expect(currentAvailableRelease(next)?.foundAt).toBe(100);
    expect(next.notified.release).toEqual({ version: "2.0.0", at: 500 });
  });

  it("a round with NO ok source keeps the prior release untouched", () => {
    const start = makeState({
      status: { phase: "available", release: release("2.0.0", { foundAt: 100 }) },
    });
    const next = applyTickRound(
      start,
      [{ kind: "git", result: failTransport("dns"), release: null }],
      2000,
      currentAvailableRelease(start),
    );
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
  });
});

describe("applyTickRound — bounded, newest-first history", () => {
  it("stays within UPDATE_HISTORY_ROWS and prepends the newest round", () => {
    let s = makeState();
    for (let i = 0; i < UPDATE_HISTORY_ROWS + 5; i += 1) {
      s = applyTickRound(
        s,
        [{ kind: "git", result: failTransport("timeout"), release: null }],
        1000 + i,
        currentAvailableRelease(s),
      );
    }
    expect(s.history.length).toBe(UPDATE_HISTORY_ROWS);
    expect(s.history[0]?.at).toBe(1000 + UPDATE_HISTORY_ROWS + 4);
  });

  it("classifies rows: update / up-to-date / error", () => {
    const next = applyTickRound(
      makeState(),
      [
        { kind: "git", result: okResult, release: release("2.0.0") },
        { kind: "web", result: failTransport("dns"), release: null },
      ],
      1000,
      null, // a fresh state has no previously-known release
    );
    const git = next.history.find((h) => h.source === "git");
    const web = next.history.find((h) => h.source === "web");
    expect(git?.result).toBe("update");
    expect(git?.version).toBe("2.0.0");
    expect(web?.result).toBe("error");
    expect(web?.version).toBe(null);

    const upToDate = applyTickRound(
      makeState(),
      [{ kind: "git", result: okResult, release: release("1.0.0") }],
      1000,
      null, // a fresh state has no previously-known release
    );
    expect(upToDate.history[0]?.result).toBe("up-to-date");
    expect(upToDate.history[0]?.version).toBe("1.0.0");
  });
});

// ── deriveHero: the §3 matrix ─────────────────────────────────────────────────

describe("deriveHero — the §3 rule matrix", () => {
  const src = (over: Partial<HeroSourceView> = {}): HeroSourceView => ({
    enabled: true,
    offered: true,
    paused: false,
    lastResult: null,
    ...over,
  });

  it("1: a newer availableRelease → available", () => {
    expect(
      deriveHero({
        availableRelease: release("2.0.0"),
        currentVersion: "1.0.0",
        sources: [src(), src()],
      }),
    ).toEqual({
      phase: "available",
      release: release("2.0.0"),
    });
  });

  it("1: an availableRelease that is NOT newer is ignored", () => {
    const hero = deriveHero({
      availableRelease: release("1.0.0"),
      currentVersion: "1.0.0",
      sources: [src(), src()],
    });
    expect(hero.phase).toBe("never-checked");
  });

  it("2: an OK result → up-to-date at the latest ok timestamp", () => {
    const hero = deriveHero({
      availableRelease: null,
      currentVersion: "1.0.0",
      sources: [
        src({ lastResult: { outcome: "ok", at: 100, latencyMs: null, raw: null } }),
        src({ lastResult: { outcome: "ok", at: 300, latencyMs: null, raw: null } }),
      ],
    });
    expect(hero).toEqual({ phase: "up-to-date", lastCheckedAt: 300 });
  });

  it("3: a paused source → attention needs-setup", () => {
    expect(
      deriveHero({
        availableRelease: null,
        currentVersion: "1.0.0",
        sources: [src({ paused: true }), src()],
      }),
    ).toEqual({
      phase: "attention",
      code: "needs-setup",
    });
  });

  it("3: an answered failure → attention needs-setup", () => {
    const hero = deriveHero({
      availableRelease: null,
      currentVersion: "1.0.0",
      sources: [
        src(),
        src({
          lastResult: {
            outcome: "fail",
            at: 1,
            class: "answered",
            code: "http-404",
            latencyMs: null,
            raw: null,
          },
        }),
      ],
    });
    expect(hero).toEqual({ phase: "attention", code: "needs-setup" });
  });

  it("3 before 4: needs-setup outranks unreachable when both are present", () => {
    const hero = deriveHero({
      availableRelease: null,
      currentVersion: "1.0.0",
      sources: [
        src({ paused: true }),
        src({
          lastResult: {
            outcome: "fail",
            at: 1,
            class: "transport",
            code: "dns",
            latencyMs: null,
            raw: null,
          },
        }),
      ],
    });
    expect(hero).toEqual({ phase: "attention", code: "needs-setup" });
  });

  it("4: only transport failures → attention unreachable", () => {
    const hero = deriveHero({
      availableRelease: null,
      currentVersion: "1.0.0",
      sources: [
        src({
          lastResult: {
            outcome: "fail",
            at: 1,
            class: "transport",
            code: "timeout",
            latencyMs: null,
            raw: null,
          },
        }),
        src(),
      ],
    });
    expect(hero).toEqual({ phase: "attention", code: "unreachable" });
  });

  it("5: nothing offered/enabled → attention sources-off", () => {
    expect(
      deriveHero({
        availableRelease: null,
        currentVersion: "1.0.0",
        sources: [src({ offered: false }), src({ enabled: false })],
      }),
    ).toEqual({
      phase: "attention",
      code: "sources-off",
    });
  });

  it("6: fresh (offered+enabled, nothing checked) → never-checked", () => {
    expect(
      deriveHero({ availableRelease: null, currentVersion: "1.0.0", sources: [src(), src()] }),
    ).toEqual({ phase: "never-checked" });
  });

  it("stale verdict + all enabled sources answered-fail → needs-setup, NOT available", () => {
    const hero = deriveHero({
      availableRelease: release("2.0.0"),
      currentVersion: "1.0.0",
      sources: [
        src({
          lastResult: {
            outcome: "fail",
            at: 1,
            class: "answered",
            code: "git-access-denied",
            latencyMs: null,
            raw: null,
          },
        }),
      ],
    });
    expect(hero).toEqual({ phase: "attention", code: "needs-setup" });
  });

  it("stale verdict + no offered+enabled source → sources-off, NOT available", () => {
    expect(
      deriveHero({
        availableRelease: release("2.0.0"),
        currentVersion: "1.0.0",
        sources: [src({ offered: false }), src({ enabled: false })],
      }),
    ).toEqual({ phase: "attention", code: "sources-off" });
  });

  it("stale verdict + one source answered-fail + one source ok → still available", () => {
    const hero = deriveHero({
      availableRelease: release("2.0.0"),
      currentVersion: "1.0.0",
      sources: [
        src({
          lastResult: {
            outcome: "fail",
            at: 1,
            class: "answered",
            code: "git-access-denied",
            latencyMs: null,
            raw: null,
          },
        }),
        src({
          lastResult: { outcome: "ok", at: 2, latencyMs: null, raw: null },
        }),
      ],
    });
    expect(hero).toEqual({ phase: "available", release: release("2.0.0") });
  });
});

// ── run lifecycle ─────────────────────────────────────────────────────────────

describe("run lifecycle", () => {
  it("startRun seeds the download phase + one log line", () => {
    const s = startRun(makeState(), release("2.0.0"), 100);
    expect(s.run?.phase).toBe("download");
    expect(s.run?.pct).toBe(0);
    expect(s.run?.targetVersion).toBe("2.0.0");
    expect(s.run?.fromVersion).toBe("1.0.0");
    expect(s.run?.log).toHaveLength(1);
  });

  it("advanceRunPhase moves the phase; no-op when there is no run", () => {
    const s = advanceRunPhase(startRun(makeState(), release("2.0.0"), 100), "verify");
    expect(s.run?.phase).toBe("verify");
    expect(advanceRunPhase(makeState(), "verify").run).toBe(null);
  });

  it("setRunPct is monotone and deduped (non-advancing returns the SAME state)", () => {
    let s = startRun(makeState(), release("2.0.0"), 100);
    s = setRunPct(s, 50);
    expect(s.run?.pct).toBe(50);
    const same = setRunPct(s, 40);
    expect(same).toBe(s); // no advance → identical reference (no wire churn)
    const same2 = setRunPct(s, 50);
    expect(same2).toBe(s);
    s = setRunPct(s, 80);
    expect(s.run?.pct).toBe(80);
  });

  it("setRunPct clamps to 0..100 and no-ops without a run", () => {
    let s = startRun(makeState(), release("2.0.0"), 100);
    s = setRunPct(s, 250);
    expect(s.run?.pct).toBe(100);
    expect(setRunPct(makeState(), 50).run).toBe(null);
  });

  it("appendRunLogLine grows the log", () => {
    const s = appendRunLogLine(
      startRun(makeState(), release("2.0.0"), 100),
      200,
      "ok",
      "verify.done",
      { sha: "ab" },
    );
    expect(s.run?.log).toHaveLength(2);
    expect(s.run?.log[1]).toEqual({
      at: 200,
      tone: "ok",
      code: "verify.done",
      params: { sha: "ab" },
    });
  });

  it("failRun terminates in the failed phase with the error", () => {
    const s = failRun(startRun(makeState(), release("2.0.0"), 100), {
      code: "archive-integrity",
      raw: "sha256 9f3c1b7e…",
      params: {},
    });
    expect(s.run?.phase).toBe("failed");
    expect(s.run?.error).toEqual({
      code: "archive-integrity",
      raw: "sha256 9f3c1b7e…",
      params: {},
    });
  });
});

// ── check guards ──────────────────────────────────────────────────────────────

describe("check guards — no-op while a run is active", () => {
  // The flag, NOT the hero: a check used to REPLACE the hero status, and the hero status is where
  // the advertised release lives — so a background tick blanked «Доступна vX» for the whole round.
  it("checkStarted raises the in-flight flag when idle", () => {
    const started = checkStarted(makeState());
    expect(started.checking).toBe(true);
    expect(started.status).toEqual(makeState().status);
    expect(canCheckNow(makeState())).toBe(true);
  });

  it("checkStarted is a no-op while a run is active (INV-6)", () => {
    const running = startRun(makeState(), release("2.0.0"), 100);
    expect(checkStarted(running)).toBe(running);
    expect(canCheckNow(running)).toBe(false);
  });

  // A run that already failed is terminal. Treating it as "active" made «Проверить» a dead
  // button on the one hero that needs it most — the failed one.
  it("a FAILED run does not block a check", () => {
    const failed = failRun(startRun(makeState(), release("2.0.0"), 100), {
      code: "download-failed",
      raw: "HTTP 404",
      params: {},
    });
    expect(canCheckNow(failed)).toBe(true);
    expect(checkStarted(failed).checking).toBe(true);
  });

  it("a settled check retires a failed run (and never touches a live one)", () => {
    const failed = failRun(startRun(makeState(), release("2.0.0"), 100), {
      code: "download-failed",
      raw: "HTTP 404",
      params: {},
    });
    const settled = applyTickRound(
      failed,
      [{ kind: "git", result: okResult, release: null }],
      2000,
      currentAvailableRelease(failed),
    );
    expect(settled.run).toBeNull();

    const live = startRun(makeState(), release("2.0.0"), 100);
    const duringRun = applyTickRound(
      live,
      [{ kind: "git", result: okResult, release: null }],
      2000,
      currentAvailableRelease(live),
    );
    expect(duringRun.run).toEqual(live.run);
  });
});

// ── settings / credentials ────────────────────────────────────────────────────

describe("toggle & auto-check scheduling", () => {
  it("toggleSource flips only the named source's enabled", () => {
    const s = toggleSource(makeState(), "git", false);
    expect(s.git.enabled).toBe(false);
    expect(s.web.enabled).toBe(true);
  });

  it("setAutoCheck armed → nextCheckAt from the injected tick fn", () => {
    const s = setAutoCheck(makeState({ autoCheck: false }), true, 1000, (now) => now + 999);
    expect(s.autoCheck).toBe(true);
    expect(s.nextCheckAt).toBe(1999);
  });

  it("setAutoCheck off → nextCheckAt null (tick fn not consulted)", () => {
    const s = setAutoCheck(makeState({ nextCheckAt: 5 }), false, 1000, () => {
      throw new Error("must not compute a tick when disabling");
    });
    expect(s.autoCheck).toBe(false);
    expect(s.nextCheckAt).toBe(null);
  });

  it("setNotifyPrefs replaces the mutes", () => {
    const s = setNotifyPrefs(makeState(), { releasesMuted: true, problemsMuted: true });
    expect(s.notify).toEqual({ releasesMuted: true, problemsMuted: true });
  });

  it("markNotified stamps the release with the version it covers", () => {
    const s = makeState({ status: { phase: "available", release: release("2.0.0") } });
    expect(markNotified(s, "release", 4242).notified.release).toEqual({
      version: "2.0.0",
      at: 4242,
    });
  });

  it("markNotified(release) is a no-op when no release is advertised", () => {
    expect(markNotified(makeState(), "release", 4242).notified.release).toBe(null);
  });

  it("markNotified stamps problems independently of the release", () => {
    const s = markNotified(
      makeState({ notified: { release: { version: "2.0.0", at: 1 }, problems: null } }),
      "problems",
      99,
    );
    expect(s.notified).toEqual({ release: { version: "2.0.0", at: 1 }, problems: { at: 99 } });
  });
});

describe("setPressRefusal — the inline answer to a refused press", () => {
  it("records the reason and clears on null", () => {
    const refused = setPressRefusal(makeState(), {
      code: "node-too-old",
      raw: null,
      params: { required: ">=22", running: "20.11.0" },
    });
    expect(refused.pressRefusal).toEqual({
      code: "node-too-old",
      raw: null,
      params: { required: ">=22", running: "20.11.0" },
    });
    expect(setPressRefusal(refused, null).pressRefusal).toBe(null);
  });

  it("a started run supersedes it", () => {
    const refused = setPressRefusal(makeState(), { code: "no-update", raw: null, params: {} });
    expect(startRun(refused, release("2.0.0"), 1000).pressRefusal).toBe(null);
  });

  it("a settled check answers it", () => {
    const refused = setPressRefusal(makeState(), { code: "no-update", raw: null, params: {} });
    const settled = applyTickRound(
      refused,
      [{ kind: "git", result: okResult, release: null }],
      2000,
      currentAvailableRelease(refused),
    );
    expect(settled.pressRefusal).toBe(null);
  });
});

describe("credentialsSaved — unpause + reset + ok lastResult", () => {
  const sshMeta: SshCredMeta = {
    fingerprint: "SHA256:abc",
    keyType: "ed25519",
    savedAt: 999,
    origin: "generate",
  };
  const userPass: UserPassCredMeta = { username: "u", savedAt: 999 };

  it("git ssh: unpauses, clears authFails, records an ok result, sets ssh metadata", () => {
    const start = makeState({
      git: gitSource({
        paused: true,
        authFails: 2,
        transportStreak: 3,
        failingSince: 100,
        authVia: "https",
        httpsCred: userPass,
      }),
    });
    const next = credentialsSaved(start, { authVia: "ssh", sshCred: sshMeta }, 5000);
    expect(next.git.paused).toBe(false);
    expect(next.git.authFails).toBe(0);
    expect(next.git.transportStreak).toBe(0);
    expect(next.git.failingSince).toBe(null);
    expect(next.git.lastResult).toEqual({ outcome: "ok", at: 5000, latencyMs: null, raw: null });
    expect(next.git.authVia).toBe("ssh");
    expect(next.git.sshCred).toEqual(sshMeta);
    expect(next.git.httpsCred).toBe(null);
  });

  it("git https: sets https metadata, clears ssh", () => {
    const next = credentialsSaved(
      makeState({ git: gitSource({ sshCred: sshMeta, authVia: "ssh" }) }),
      { authVia: "https", httpsCred: userPass },
      5000,
    );
    expect(next.git.authVia).toBe("https");
    expect(next.git.httpsCred).toEqual(userPass);
    expect(next.git.sshCred).toBe(null);
  });

  it("web: unpauses and sets the basic-auth metadata", () => {
    const start = makeState({ web: webSource({ paused: true, authFails: 2 }) });
    const next = credentialsSaved(start, { authVia: "web", cred: userPass }, 5000);
    expect(next.web.paused).toBe(false);
    expect(next.web.authFails).toBe(0);
    expect(next.web.cred).toEqual(userPass);
    expect(next.web.lastResult).toEqual({ outcome: "ok", at: 5000, latencyMs: null, raw: null });
  });
});

// ── applyProbeResult: manual probe never owns the release verdict ────────────
describe("applyProbeResult — probes never touch the advertised release", () => {
  it("an OK probe of the OTHER source keeps the found release", () => {
    const start = makeState({ status: { phase: "available", release: release("2.0.0") } });
    const next = applyProbeResult(start, "web", okResult, 1000);
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
    expect(next.web.lastResult?.outcome).toBe("ok");
    expect(next.history[0]).toMatchObject({ source: "web", result: "up-to-date" });
  });

  it("an OK probe unpauses a paused source and keeps the release", () => {
    const start = makeState({
      status: { phase: "available", release: release("2.0.0") },
      git: { ...gitSource(), paused: true, authFails: 2 },
    });
    const next = applyProbeResult(start, "git", okResult, 1000);
    expect(next.git.paused).toBe(false);
    expect(next.git.authFails).toBe(0);
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
  });

  it("a FAILED probe records the failure + history but keeps the release", () => {
    const start = makeState({ status: { phase: "available", release: release("2.0.0") } });
    const next = applyProbeResult(start, "git", failTransport("timeout"), 1000);
    expect(next.git.transportStreak).toBe(1);
    expect(currentAvailableRelease(next)?.version).toBe("2.0.0");
    expect(next.history[0]).toMatchObject({ source: "git", result: "error" });
  });

  it("without a release, hero re-derives from the probe result", () => {
    const start = makeState();
    const next = applyProbeResult(start, "git", okResult, 1000);
    expect(next.status).toEqual({ phase: "up-to-date", lastCheckedAt: 1000 });
  });
});

// ── a check that never settles, and a run that never finishes ────────────────
// Both exist because the RPCs now REPLY as soon as their work is under way: nothing is awaiting the
// fiber that finishes it, so the state has to be able to close itself. These are the two decisions
// a finalizer makes, kept pure so every phase can be checked without a fiber.

describe("checkAborted", () => {
  it("takes both cards out of «проверяю…» and leaves every verdict standing", () => {
    // A round in flight over a state that already knows something: the flag is up and the leg the
    // round has reached is spinning.
    const known = makeState({
      web: webSource({ lastResult: { outcome: "ok", at: 500, latencyMs: 10, raw: "200 OK" } }),
      status: { phase: "up-to-date", lastCheckedAt: 500 },
    });
    const start = probeStarted(checkStarted(known), "web");
    expect(start.checking).toBe(true);
    expect(start.web.probing).toBe(true);

    const next = checkAborted(start);

    expect(next.checking).toBe(false);
    expect(next.web.probing).toBe(false);
    expect(next.git.probing).toBe(false);
    // An abandoned round invents nothing AND destroys nothing: the hero is exactly what it was
    // before the round started. It used to be RECOMPUTED here with `availableRelease: null`, which
    // is how an interrupted check erased a release the user had been offered.
    expect(next.status).toEqual(known.status);
  });

  it("keeps an advertised release (and its quiet stamp) across an abort", () => {
    const offering = makeState({
      status: { phase: "available", release: release("2.0.0") },
      notified: { release: { version: "2.0.0", at: 100 }, problems: null },
    });
    const aborted = checkAborted(checkStarted(offering));
    expect(currentAvailableRelease(aborted)?.version).toBe("2.0.0");
    expect(aborted.notified.release?.at).toBe(100);
  });

  it("is a no-op once the round settled — safe to call blindly from a finalizer", () => {
    const settled = applyTickRound(
      checkStarted(makeState()),
      [],
      1000,
      null, // a fresh state has no previously-known release
    );
    expect(settled.checking).toBe(false);

    expect(checkAborted(settled)).toEqual(settled);
    // …and idempotent on its own output.
    const aborted = checkAborted(checkStarted(makeState()));
    expect(checkAborted(aborted)).toEqual(aborted);
  });
});

describe("AU-09 — a check must not wipe the «Позже» stamp", () => {
  // The chain: `checkStarted` replaces the hero status, and the hero status is where the available
  // release LIVES (`currentAvailableRelease` reads `status.release`). So by the time the round
  // settles, `applyTickRound` looks for the previously-known release and finds null — concludes the
  // version is brand new — and clears the dismissal. Result: a release the user waved away with
  // «Позже» is re-announced at the very next check instead of in two hours, and its `foundAt`
  // jumps to now every time, so «найдено N назад» never ages.
  const found = (version: string): TickSourceOutcome => ({
    kind: "web",
    result: okResult,
    release: release(version),
  });

  it("keeps the stamp, and the original foundAt, when the SAME version is found again", () => {
    // 1. a round finds 2.0.0 — brand new, so the dismissal clears (correct).
    const first = applyTickRound(
      makeState(),
      [found("2.0.0")],
      1_000,
      null, // a fresh state has no previously-known release
    );
    expect(first.status.phase).toBe("available");

    // 2. the user presses «Позже».
    const dismissed = markNotified(first, "release", 2_000);
    expect(dismissed.notified.release?.version).toBe("2.0.0");

    // 3. the next check begins. The release now SURVIVES it — that is the AU-10 fix — so the
    // prior-release argument below is no longer the only thing standing between the user and a
    // re-announcement. It is still passed explicitly, because `applyTickRound` must not depend on
    // the caller having left the hero intact.
    const checking = checkStarted(dismissed);
    expect(currentAvailableRelease(checking)?.version).toBe("2.0.0");

    // 4. …and settles on the SAME version. Nothing is news here.
    const settled = applyTickRound(
      checking,
      [found("2.0.0")],
      9_000,
      currentAvailableRelease(dismissed),
    );

    expect(settled.notified.release?.version).toBe("2.0.0");
    expect(settled.notified.release?.at).toBe(2_000);
    // The release is not newly found, so its age keeps counting from when it really appeared.
    expect(settled.status.phase === "available" ? settled.status.release.foundAt : null).toBe(
      1_000,
    );
  });

  it("still announces a genuinely NEWER version", () => {
    const first = applyTickRound(
      makeState(),
      [found("2.0.0")],
      1_000,
      null, // a fresh state has no previously-known release
    );
    const dismissed = markNotified(first, "release", 2_000);
    const checking = checkStarted(dismissed);

    const settled = applyTickRound(
      checking,
      [found("3.0.0")],
      9_000,
      currentAvailableRelease(dismissed),
    );

    // A new version IS news: the quiet stamp goes, and foundAt is now.
    expect(settled.notified.release).toBe(null);
    expect(settled.status.phase === "available" ? settled.status.release.foundAt : null).toBe(
      9_000,
    );
  });
});

describe("scheduleBeatDecision", () => {
  const runAtPhase = (phase: "download" | "failed") => ({
    targetVersion: "2.0.0",
    fromVersion: "1.0.0",
    phase,
    pct: 0,
    log: [],
    error: phase === "failed" ? { code: "download-failed", raw: null, params: {} } : null,
  });
  const due = makeState({ autoCheck: true, nextCheckAt: 1000 });

  it("ticks when the schedule is due and nothing is in flight", () => {
    expect(scheduleBeatDecision(due, 1000)).toBe("tick");
    expect(scheduleBeatDecision(due, 5000)).toBe("tick");
  });

  it("stays silent before the due time", () => {
    expect(scheduleBeatDecision(due, 999)).toBe("not-due");
    expect(scheduleBeatDecision(makeState({ autoCheck: true, nextCheckAt: null }), 5000)).toBe(
      "not-due",
    );
  });

  it("stands down while auto-check is off", () => {
    expect(scheduleBeatDecision(makeState({ autoCheck: false, nextCheckAt: 1000 }), 5000)).toBe(
      "auto-check-off",
    );
  });

  it("stands down while a run is genuinely in flight", () => {
    const running = makeState({ autoCheck: true, nextCheckAt: 1000, run: runAtPhase("download") });
    expect(scheduleBeatDecision(running, 5000)).toBe("run-active");
  });

  // AU-02: the bug. A failed install left `run` non-null forever (it is not persisted, but the
  // process keeps it), and the old inline guard read that as "in flight" — so scheduled checking
  // stopped dead until a human pressed something.
  it("still ticks after a run that FAILED — terminal is not in flight", () => {
    const failed = makeState({ autoCheck: true, nextCheckAt: 1000, run: runAtPhase("failed") });

    expect(canCheckNow(failed)).toBe(true);
    expect(scheduleBeatDecision(failed, 5000)).toBe("tick");
  });
});

describe("a round marks the source it has actually reached", () => {
  // The round is sequential and stops at the first OK, so marking every source it MIGHT reach was a
  // claim about intent, not about work: when git answered, the web card said «проверяю…» while zero
  // requests had been made to it.
  it("checkStarted no longer touches the cards", () => {
    const started = checkStarted(makeState());

    expect(started.checking).toBe(true);
    expect(started.git.probing).toBe(false);
    expect(started.web.probing).toBe(false);
  });

  it("probeStarted / probeStopped move exactly one card", () => {
    const git = probeStarted(makeState(), "git");
    expect(git.git.probing).toBe(true);
    expect(git.web.probing).toBe(false);

    const done = probeStopped(git, "git");
    expect(done.git.probing).toBe(false);
    expect(done.web.probing).toBe(false);

    const web = probeStarted(makeState(), "web");
    expect(web.web.probing).toBe(true);
    expect(web.git.probing).toBe(false);
  });

  it("a settled round still clears both, as a net under an interrupted leg", () => {
    const midRound = probeStarted(checkStarted(makeState()), "web");

    const settled = applyTickRound(midRound, [], 1000, currentAvailableRelease(midRound));

    expect(settled.git.probing).toBe(false);
    expect(settled.web.probing).toBe(false);
  });
});

describe("isRunUnfinished / failUnfinishedRun", () => {
  const runAt = (phase: "download" | "verify" | "flip" | "restart" | "failed") =>
    makeState({
      run: {
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        phase,
        pct: 0,
        log: [],
        error: phase === "failed" ? { code: "download-failed", raw: null, params: {} } : null,
      },
    });

  it("counts only the phases that describe work in progress", () => {
    expect(isRunUnfinished(runAt("download"))).toBe(true);
    expect(isRunUnfinished(runAt("verify"))).toBe(true);
    expect(isRunUnfinished(runAt("flip"))).toBe(true);
    // The successful hand-off: the server is deliberately exiting, the run ended as intended.
    expect(isRunUnfinished(runAt("restart"))).toBe(false);
    expect(isRunUnfinished(runAt("failed"))).toBe(false);
    expect(isRunUnfinished(makeState())).toBe(false);
  });

  it("closes an in-progress run with a stated reason and a log line", () => {
    const closed = failUnfinishedRun(runAt("verify"), 4242);

    expect(closed.run?.phase).toBe("failed");
    expect(closed.run?.error?.code).toBe("interrupted");
    expect(closed.run?.error?.raw).toBeNull();
    expect(closed.run?.log.at(-1)?.code).toBe("run.failed");
    expect(closed.run?.log.at(-1)?.params.code).toBe("interrupted");
  });

  it("leaves a finished run exactly as it was", () => {
    for (const phase of ["restart", "failed"] as const) {
      const state = runAt(phase);
      expect(failUnfinishedRun(state, 4242)).toEqual(state);
    }
    expect(failUnfinishedRun(makeState(), 4242)).toEqual(makeState());
  });
});
