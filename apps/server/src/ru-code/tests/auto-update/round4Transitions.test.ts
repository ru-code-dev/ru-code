// ru-code: the pure half of round 4 — the state-machine changes that carry a user-visible promise.
//
// Each block states the DEFECT it pins, because a test that only describes the current behaviour
// cannot tell a future reader which parts are load-bearing.

import { describe, expect, it } from "vite-plus/test";

import type { AutoUpdateWireState, AvailableReleaseWire } from "@t3tools/contracts";

import {
  applyPressRound,
  applyTickRound,
  checkAborted,
  checkStarted,
  probeStarted,
  credentialsSaved,
  currentAvailableRelease,
  type TickSourceOutcome,
} from "../../auto-update/engine/transitions.ts";

const NOW = 1_760_000_000_000;

const release = (version: string, foundAt = NOW): AvailableReleaseWire => ({
  version,
  releasedAt: NOW - 86_400_000,
  sizeBytes: 34_000_000,
  sha256: "a".repeat(64),
  changelog: [],
  changelogTruncated: false,
  foundAt,
});

const source = () => ({
  enabled: true,
  offered: true,
  url: "git@example.com:org/repo.git",
  paused: false,
  authFails: 0,
  transportStreak: 0,
  failingSince: null,
  lastResult: null,
  probing: false,
});

const state = (over: Partial<AutoUpdateWireState> = {}): AutoUpdateWireState =>
  ({
    currentVersion: "1.0.0",
    facts: {
      installDir: "/app/bin",
      entryJs: "/app/bin/cli.js",
      pid: 1,
      port: 7777,
      address: "127.0.0.1:7777",
      canApply: true,
      blockReason: null,
    },
    autoCheck: true,
    nextCheckAt: NOW + 3_600_000,
    git: { ...source(), authVia: "ambient", httpsCred: null, sshCred: null },
    web: { ...source(), cred: null },
    status: { phase: "never-checked" },
    history: [],
    run: null,
    lastApply: null,
    notify: { releasesMuted: false, problemsMuted: false },
    notified: { release: null, problems: null },
    pressRefusal: null,
    pressInFlight: false,
    checking: false,
    ...over,
  }) as AutoUpdateWireState;

const okRound = (version: string): ReadonlyArray<TickSourceOutcome> => [
  {
    kind: "git",
    result: { outcome: "ok", latencyMs: 12, raw: null },
    release: release(version),
  },
];

// ── AU-10: a check must not blank what the hero already knows ─────────────────────

describe("a check in flight leaves the hero alone", () => {
  const offering = state({ status: { phase: "available", release: release("2.0.0") } });

  it("checkStarted publishes the flag and keeps the advertised release", () => {
    const started = checkStarted(offering);
    expect(started.checking).toBe(true);
    // The DEFECT: this used to become `{phase:"checking"}`, and the hero status is where the
    // release lives — so every background tick dropped «Доступна vX», unmounted the release notes
    // and hid the sidebar pill until the round settled.
    expect(started.status.phase).toBe("available");
    expect(currentAvailableRelease(started)?.version).toBe("2.0.0");
  });

  it("a settled round clears the flag", () => {
    const settled = applyTickRound(checkStarted(offering), okRound("2.0.0"), NOW, release("2.0.0"));
    expect(settled.checking).toBe(false);
  });

  it("checkStarted is still a no-op while a run is in flight", () => {
    const running = state({
      run: {
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        phase: "download",
        pct: 10,
        log: [],
        error: null,
      },
    });
    expect(checkStarted(running)).toBe(running);
  });
});

// ── N3: an ABORTED check must not destroy the release (nor the «Позже» stamp) ──────

describe("an aborted check keeps what was already known", () => {
  const offering = state({
    status: { phase: "available", release: release("2.0.0") },
    notified: { release: { version: "2.0.0", at: NOW - 1000 }, problems: null },
  });

  it("clears the in-flight marks and NOTHING else", () => {
    const aborted = checkAborted(checkStarted(offering));
    expect(aborted.checking).toBe(false);
    expect(aborted.git.probing).toBe(false);
    expect(aborted.web.probing).toBe(false);
    // The DEFECT: this used to recompute the hero with `availableRelease: null`, so an interrupted
    // round erased the release — and the NEXT round then saw no prior version, concluded the same
    // release was brand new, and dropped the user's «Позже» stamp.
    expect(currentAvailableRelease(aborted)?.version).toBe("2.0.0");
    expect(aborted.notified.release?.version).toBe("2.0.0");
  });

  it("the round after an abort still recognises the SAME release and keeps the quiet window", () => {
    const aborted = checkAborted(checkStarted(offering));
    const settled = applyTickRound(
      checkStarted(aborted),
      okRound("2.0.0"),
      NOW + 5_000,
      currentAvailableRelease(aborted),
    );
    expect(settled.notified.release?.version).toBe("2.0.0");
    expect(currentAvailableRelease(settled)?.foundAt).toBe(release("2.0.0").foundAt);
  });

  it("is idempotent — calling it on a settled round changes nothing", () => {
    const settled = applyTickRound(checkStarted(offering), okRound("2.0.0"), NOW, release("2.0.0"));
    expect(checkAborted(settled)).toBe(settled);
  });
});

// ── a press's round must not touch a CONCURRENT check's in-flight state ───────────

describe("applyPressRound", () => {
  // A press runs its resolve under `applyLock`; a scheduled round runs under `checkLock`. Different
  // semaphores, so the two genuinely overlap — and the tick settler clears `checking` and BOTH
  // `probing` flags unconditionally. Recording a press round through it would switch a card out of
  // «проверяю…» while that source's request was still on the wire, and re-enable buttons a live
  // round had quieted: the exact lie, in the other direction, that the per-source marking exists to
  // prevent.
  const midCheck = probeStarted(checkStarted(state()), "git");

  it("applies the results and the history without touching the round's lifecycle", () => {
    const recorded = applyPressRound(midCheck, okRound("2.0.0"), NOW, null);

    // The verdict IS applied — that is the point of recording it.
    expect(currentAvailableRelease(recorded)?.version).toBe("2.0.0");
    expect(recorded.history.length).toBe(1);
    // …and the concurrent round is left exactly as it was.
    expect(recorded.checking).toBe(true);
    expect(recorded.git.probing).toBe(true);
  });

  it("never clears a live run", () => {
    const running = state({
      run: {
        targetVersion: "2.0.0",
        fromVersion: "1.0.0",
        phase: "download",
        pct: 10,
        log: [],
        error: null,
      },
    });
    expect(applyPressRound(running, okRound("2.0.0"), NOW, null).run).toEqual(running.run);
  });

  it("still records the failure counters a scheduled round would", () => {
    const denied = applyPressRound(
      midCheck,
      [
        {
          kind: "web",
          result: {
            outcome: "fail",
            class: "answered",
            code: "http-401",
            latencyMs: 5,
            raw: "HTTP 401",
          },
          release: null,
        },
      ],
      NOW,
      null,
    );
    expect(denied.web.authFails).toBe(1);
    expect(denied.history.length).toBe(1);
  });
});

// ── T8: the saved-credential metadata decides its own source ──────────────────────

describe("credentialsSaved derives the source from the metadata", () => {
  it("ssh metadata lands on git and clears the https half", () => {
    const next = credentialsSaved(
      state({
        git: {
          ...source(),
          authVia: "https",
          httpsCred: { username: "bot", savedAt: NOW },
          sshCred: null,
          paused: true,
          authFails: 2,
        },
      }) as AutoUpdateWireState,
      {
        authVia: "ssh",
        sshCred: {
          fingerprint: "SHA256:x",
          keyType: "ed25519",
          savedAt: NOW,
          origin: "generate",
        },
      },
      NOW,
    );
    expect(next.git.authVia).toBe("ssh");
    expect(next.git.httpsCred).toBeNull();
    expect(next.git.paused).toBe(false);
    expect(next.git.authFails).toBe(0);
    // The web source is untouched — the mismatched pair that used to be representable
    // (`("git", {authVia:"web"})`) cannot be expressed at all now.
    expect(next.web.cred).toBeNull();
  });

  it("web metadata lands on web and leaves git alone", () => {
    const start = state({ web: { ...source(), cred: null, paused: true, authFails: 2 } });
    const next = credentialsSaved(
      start,
      { authVia: "web", cred: { username: "bot", savedAt: NOW } },
      NOW,
    );
    expect(next.web.cred?.username).toBe("bot");
    expect(next.web.paused).toBe(false);
    expect(next.git).toEqual(start.git);
  });
});
