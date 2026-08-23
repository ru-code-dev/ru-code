// ru-code: unit tests for the v3 auto-update presentation mapper (the localization
// boundary). Every machine code → its sentence: failure codes, attention codes,
// run phases, run-log codes (incl. unknown fallback), lastApply reasons, the RPC
// error map; source-card health derivation; hero composition; timestamp helpers.
// `now` is injected throughout (no Date.now default).
import { describe, expect, it } from "vite-plus/test";

import type {
  AutoUpdateWireState,
  AvailableReleaseWire,
  GitSourceWire,
  UpdateFailureCode,
  UpdateRunLogEventWire,
  WebSourceWire,
} from "@t3tools/contracts";
import { UPDATE_PRESS_REFUSAL_CODES } from "@t3tools/contracts";

import { anySourceCheckable, anySourceWorks, sourceHealth } from "../../auto-update-ui/model";
import {
  agoRu,
  applyFailureSentence,
  atRu,
  attentionView,
  autoUpdateErrorMessage,
  clockHm,
  failureSentence,
  inRu,
  isPressRefusalCode,
  lastApplyReason,
  releaseToUi,
  runLogText,
  runPhaseLabel,
  timeHms,
  wireToUi,
} from "../../auto-update-ui/store/wireToUi";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const NOW = 1_800_000_000_000;

// ── time helpers ────────────────────────────────────────────────────────────────

describe("agoRu", () => {
  it("maps representative past deltas", () => {
    expect(agoRu(NOW - 30_000, NOW)).toBe("just now");
    expect(agoRu(NOW - 1 * MIN, NOW)).toBe("1 minute ago");
    expect(agoRu(NOW - 5 * MIN, NOW)).toBe("5 minutes ago");
    expect(agoRu(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
    expect(agoRu(NOW - 3 * DAY, NOW)).toBe("3 days ago");
  });
});

describe("inRu", () => {
  it("maps representative future deltas", () => {
    // ru-code (round 12): inRu's shape now matches agoRu's (full plural nouns, not
    // abbreviations) — was "in 40 min" / "in 6 h" / "in 7 d".
    expect(inRu(NOW + 10_000, NOW)).toBe("now");
    expect(inRu(NOW + 40 * MIN, NOW)).toBe("in 40 minutes");
    expect(inRu(NOW + 6 * HOUR, NOW)).toBe("in 6 hours");
    expect(inRu(NOW + 7 * DAY, NOW)).toBe("in 7 days");
  });
});

describe("atRu", () => {
  const noon = new Date(2026, 6, 23, 12, 0).getTime();
  it("labels today / yesterday / older and formats HH:MM", () => {
    expect(atRu(new Date(2026, 6, 23, 9, 14).getTime(), noon)).toBe("Today, 09:14");
    expect(atRu(new Date(2026, 6, 22, 21, 14).getTime(), noon)).toBe("Yesterday, 21:14");
    expect(atRu(new Date(2026, 6, 21, 21, 14).getTime(), noon)).toBe("21 July, 21:14");
  });
  it("uses «Just now» within a minute", () => {
    expect(atRu(noon - 20_000, noon)).toBe("Just now");
  });
});

describe("timeHms", () => {
  it("renders the wall-clock HH:MM:SS", () => {
    expect(timeHms(new Date(2026, 6, 23, 9, 4, 7).getTime())).toBe("09:04:07");
  });
});

describe("clockHm", () => {
  it("renders the wall-clock HH:MM of a scheduled instant", () => {
    expect(clockHm(new Date(2026, 6, 23, 9, 4).getTime())).toBe("09:04");
    expect(clockHm(new Date(2026, 6, 23, 17, 30).getTime())).toBe("17:30");
  });
});

// ── code → sentence maps ────────────────────────────────────────────────────────

describe("failureSentence", () => {
  it("maps every failure code to a non-empty sentence", () => {
    const codes: UpdateFailureCode[] = [
      "dns",
      "timeout",
      "refused",
      "reset",
      "no-route",
      "tls",
      "blocked-shape",
      "transport-other",
      "http-401",
      "http-403",
      "http-404",
      "http-status",
      "invalid-manifest",
      "git-not-found",
      "git-access-denied",
    ];
    for (const code of codes) {
      expect(failureSentence(code).length).toBeGreaterThan(0);
    }
    expect(failureSentence("http-401")).toBe("Sign-in required — the credentials were rejected.");
    expect(failureSentence("git-not-found")).toBe("The repository was not found.");
  });

  it("falls back to a generic sentence for an unknown code", () => {
    expect(failureSentence("weird-code" as UpdateFailureCode)).toBe("Something went wrong.");
  });
});

describe("attentionView", () => {
  it("maps each attention code to a title + message", () => {
    expect(attentionView("sources-off").title).toBe("Auto-update is off");
    expect(attentionView("needs-setup").title).toBe("A source needs attention");
    expect(attentionView("unreachable").message.length).toBeGreaterThan(0);
  });
});

describe("runPhaseLabel", () => {
  it("maps each wire run phase to a label", () => {
    expect(runPhaseLabel("download")).toBe("Downloading");
    expect(runPhaseLabel("verify")).toBe("Verifying");
    expect(runPhaseLabel("flip")).toBe("Installing");
    expect(runPhaseLabel("restart")).toBe("Restarting");
    expect(runPhaseLabel("failed")).toBe("Failed");
  });
});

describe("runLogText", () => {
  const ev = (code: string, params: Record<string, string> = {}): UpdateRunLogEventWire => ({
    at: NOW,
    tone: "ok",
    code,
    params,
  });

  it("maps known codes to templates using params", () => {
    expect(runLogText(ev("run.requested", { version: "1.4.2" }))).toBe(
      "requested update to v1.4.2",
    );
    expect(runLogText(ev("run.download", { version: "1.4.2", sizeBytes: "12100000" }))).toBe(
      "downloading ru-code-1.4.2.tgz (12.1 MB)…",
    );
    expect(runLogText(ev("run.verified", { sha256: "9f3c1b7e" }))).toBe(
      "sha256 matched · 9f3c1b7e…",
    );
    expect(runLogText(ev("run.restart", { port: "7777" }))).toBe("restarting on port 7777…");
  });

  // The failure code travels as a PARAM. It used to be baked into the event code
  // (`run.failed.download-failed`), which no template matched, so the journal the user reads
  // printed the raw code + params instead of a sentence.
  it("renders a failed run as a sentence, with the evidence only when there is any", () => {
    expect(runLogText(ev("run.failed", { code: "download-failed", detail: "HTTP 404" }))).toBe(
      "update failed · The update could not be downloaded. (HTTP 404)",
    );
    expect(runLogText(ev("run.failed", { code: "spawn-failed" }))).toBe(
      "update failed · The new version could not be started.",
    );
    expect(runLogText(ev("run.failed", {}))).toBe("update failed · Something went wrong.");
  });

  it("renders unknown codes + params verbatim (never crashes)", () => {
    expect(runLogText(ev("weird.code", { a: "1", b: "x" }))).toBe("weird.code a=1 b=x");
    expect(runLogText(ev("bare.code"))).toBe("bare.code");
  });
});

// ONE table serves the live run and the post-restart journal, because they describe the same
// event. Every code below is one the engine can actually emit — the previous run table reached
// for the CHECK's transport/HTTP vocabulary, which shares not a single code with a run, so every
// failed run titled as the generic «Что-то пошло не так.».
const APPLY_FAILURE_CODES = [
  "download-failed",
  "download-timeout",
  "superseded",
  "archive-integrity",
  "file-integrity",
  "structure",
  "flip-failed",
  "spawn-failed",
  "port-busy",
  "not-applied",
  "node-too-old",
];

describe("applyFailureSentence", () => {
  it("gives every emitted apply-failure code its OWN sentence", () => {
    const seen = new Set<string>();
    for (const code of APPLY_FAILURE_CODES) {
      const sentence = applyFailureSentence(code);
      expect(sentence).not.toBe("Something went wrong.");
      seen.add(sentence);
    }
    expect(seen.size).toBe(APPLY_FAILURE_CODES.length);
  });

  it("falls back to the generic sentence for an unknown code", () => {
    expect(applyFailureSentence("brand-new-code")).toBe("Something went wrong.");
  });
});

describe("lastApplyReason", () => {
  it("maps known reason codes and falls back for unknown", () => {
    expect(lastApplyReason("archive-integrity")).toBe(
      "The downloaded file was corrupted (checksum mismatch).",
    );
    expect(lastApplyReason("port-busy")).toBe("The port was busy after the restart.");
    expect(lastApplyReason("mystery")).toBe("Something went wrong.");
  });

  it("reads the same as the live run for the same code (one event, one wording)", () => {
    for (const code of APPLY_FAILURE_CODES) {
      expect(lastApplyReason(code)).toBe(applyFailureSentence(code));
    }
  });
});

describe("autoUpdateErrorMessage", () => {
  it("maps known error codes and falls back to the detail", () => {
    expect(autoUpdateErrorMessage({ code: "not-connected", detail: "" }).description).toContain(
      "No connection",
    );
    expect(autoUpdateErrorMessage({ detail: "boom" }).description).toBe("boom");
    expect(autoUpdateErrorMessage({ detail: "" }).description).toBe("Something went wrong.");
  });

  // AU-14. Every code the SERVER attaches to a credential-wizard failure used to fall through to
  // `default` — and because they ARE coded, that branch refuses to print `detail`, so all four
  // surfaced as «Что-то пошло не так» with the actual reason thrown away. These are the exact
  // strings `updateEngineLive.ts` emits (8 sites); if one is renamed there, this fails here.
  it.each([
    ["creds-test-failed", "rejected them"],
    ["creds-save-failed", "could not be saved"],
    ["keygen-failed", "could not be generated"],
  ])("states the reason for %s", (code, fragment) => {
    const { description } = autoUpdateErrorMessage({ code, detail: "server-side english" });

    expect(description).toContain(fragment);
    expect(description).not.toBe("Something went wrong.");
    // The English log line never reaches the user — that is what put English under Russian copy.
    expect(description).not.toContain("server-side english");
  });
});

// ── release ────────────────────────────────────────────────────────────────────

const releaseWire = (over: Partial<AvailableReleaseWire> = {}): AvailableReleaseWire => ({
  version: "1.4.2",
  releasedAt: NOW - 2 * HOUR,
  sizeBytes: 12_100_000,
  sha256: "9f3c1b7e4a2d8c6f5e0a9b1d3c7e8f2a",
  changelog: [
    {
      version: "1.4.2",
      notes: [
        { kind: "perf", text: "быстрее" },
        { kind: null, text: "без бейджа" },
      ],
    },
    { version: "1.4.1", notes: [{ kind: "fix", text: "починка" }] },
  ],
  changelogTruncated: false,
  foundAt: NOW - 2 * HOUR,
  ...over,
});

describe("releaseToUi", () => {
  it("groups the changelog by version and preserves null kinds", () => {
    const ui = releaseToUi(releaseWire(), NOW);
    expect(ui.version).toBe("1.4.2");
    expect(ui.releasedAgo).toBe("2 hours ago");
    expect(ui.sizeMb).toBe(12.1);
    expect(ui.changelog).toHaveLength(2);
    expect(ui.changelog[0]?.notes[1]).toEqual({ kind: null, text: "без бейджа" });
  });

  it("surfaces truncation and null releasedAt/sizeBytes", () => {
    const ui = releaseToUi(
      releaseWire({ changelogTruncated: true, releasedAt: null, sizeBytes: null }),
      NOW,
    );
    expect(ui.changelogTruncated).toBe(true);
    expect(ui.releasedAgo).toBe("recently");
    expect(ui.sizeMb).toBe(0);
  });
});

// ── full-state fixtures ──────────────────────────────────────────────────────────

const gitWire = (over: Partial<GitSourceWire> = {}): GitSourceWire => ({
  enabled: true,
  offered: true,
  url: "git.acme.dev/team/ru-code-releases.git",
  paused: false,
  authFails: 0,
  transportStreak: 0,
  failingSince: null,
  lastResult: { outcome: "ok", at: NOW - 2 * HOUR, latencyMs: 320, raw: "ls-remote OK" },
  probing: false,
  authVia: "ambient",
  httpsCred: null,
  sshCred: null,
  ...over,
});

const webWire = (over: Partial<WebSourceWire> = {}): WebSourceWire => ({
  enabled: true,
  offered: true,
  url: "downloads.acme.dev/ru-code/stable",
  paused: false,
  authFails: 0,
  transportStreak: 0,
  failingSince: null,
  lastResult: { outcome: "ok", at: NOW - 2 * HOUR, latencyMs: 41, raw: "200 OK" },
  probing: false,
  cred: null,
  ...over,
});

const fullWire = (over: Partial<AutoUpdateWireState> = {}): AutoUpdateWireState => ({
  currentVersion: "1.4.1",
  facts: {
    installDir: "~/.ru-code/bin",
    entryJs: "~/.ru-code/bin/cli.js",
    pid: 48213,
    port: 7777,
    address: "127.0.0.1:7777",
    canApply: true,
    blockReason: null,
  },
  autoCheck: true,
  nextCheckAt: NOW + 6 * HOUR,
  git: gitWire(),
  web: webWire(),
  status: { phase: "up-to-date", lastCheckedAt: NOW - 2 * HOUR },
  history: [
    {
      at: NOW - 30_000,
      source: "web",
      latencyMs: 41,
      result: "update",
      version: "1.4.2",
      raw: null,
    },
    {
      at: NOW - 30_000,
      source: "git",
      latencyMs: 320,
      result: "up-to-date",
      version: "1.4.1",
      raw: null,
    },
    {
      at: NOW - 30_000,
      source: "web",
      latencyMs: null,
      result: "error",
      version: null,
      raw: "ETIMEDOUT",
    },
  ],
  run: null,
  lastApply: null,
  notify: { releasesMuted: false, problemsMuted: false },
  notified: { release: null, problems: null },
  pressRefusal: null,
  ...over,
});

describe("wireToUi — facts / schedule / history", () => {
  it("formats facts, next-check and history", () => {
    const ui = wireToUi(fullWire(), NOW);
    expect(ui.currentVersion).toBe("1.4.1");
    expect(ui.installDir).toBe("~/.ru-code/bin");
    expect(ui.entryPoint).toBe("~/.ru-code/bin/cli.js · pid 48213 · port 7777");
    expect(ui.address).toBe("127.0.0.1:7777");
    // ru-code (round 12): inRu's shape now matches agoRu's (full plural nouns, not
    // abbreviations) — was "in 6 h".
    expect(ui.nextCheckIn).toBe("in 6 hours");
    expect(ui.status).toEqual({ phase: "up-to-date", lastCheckedAgo: "2 hours ago" });
    expect(ui.history[0]?.detail).toBe("manifest.json · found v1.4.2");
    expect(ui.history[1]?.detail).toBe("git ls-remote · v1.4.1 — latest");
    expect(ui.history[2]?.detail).toBe("ETIMEDOUT");
  });

  it("nextCheckIn is null when auto-check is off", () => {
    expect(wireToUi(fullWire({ autoCheck: false }), NOW).nextCheckIn).toBeNull();
  });

  it("nextCheckClock is the HH:MM of nextCheckAt, null when auto-check is off", () => {
    const at = new Date(2026, 6, 23, 14, 5).getTime();
    expect(wireToUi(fullWire({ nextCheckAt: at }), NOW).nextCheckClock).toBe("14:05");
    expect(wireToUi(fullWire({ autoCheck: false }), NOW).nextCheckClock).toBeNull();
  });

  it("an installation that can apply updates has no block note", () => {
    expect(wireToUi(fullWire(), NOW).applyBlocked).toBeNull();
  });

  it("a non-installed layout and a read-only folder each get their own note", () => {
    const facts = fullWire().facts;
    const layout = wireToUi(
      fullWire({ facts: { ...facts, canApply: false, blockReason: "layout" } }),
      NOW,
    ).applyBlocked;
    const readOnly = wireToUi(
      fullWire({ facts: { ...facts, canApply: false, blockReason: "read-only" } }),
      NOW,
    ).applyBlocked;
    expect(layout?.reason).toBe("layout");
    expect(readOnly?.reason).toBe("read-only");
    expect(layout?.note).not.toBe(readOnly?.note);
    expect(layout?.note.length).toBeGreaterThan(0);
    expect(readOnly?.note.length).toBeGreaterThan(0);
  });
});

describe("wireToUi — a source with no connection", () => {
  // F17: a short transport streak is NOT a probe in flight. It must read as a calm, static fact
  // with the time of the next attempt — no spinner, no «checking…».
  const flaky = (over = {}) =>
    fullWire({
      autoCheck: true,
      nextCheckAt: new Date(2026, 6, 23, 14, 5).getTime(),
      web: webWire({
        transportStreak: 2,
        failingSince: NOW - 5 * MIN,
        lastResult: {
          outcome: "fail",
          at: NOW - MIN,
          class: "transport",
          code: "timeout",
          latencyMs: null,
          raw: "ETIMEDOUT",
        },
        ...over,
      }),
    });

  it("states when the next attempt lands and never claims to be checking", () => {
    const web = wireToUi(flaky(), NOW).web;
    expect(web.state).toBe("retrying");
    expect(web.healthLine).toBe("No connection — will retry at 14:05.");
    expect(web.healthLine).not.toContain("check");
  });

  // With auto-check off the server schedules NOTHING, so «will retry» is a promise nobody keeps —
  // only a manual press can move the source. The line states the condition and stops there.
  it("makes no retry promise when auto-check is off", () => {
    const wire = flaky();
    const web = wireToUi({ ...wire, autoCheck: false }, NOW).web;
    expect(web.healthLine).toBe("No connection.");
    expect(web.healthLine).not.toMatch(/retry|keeps trying/i);
  });

  it("makes no keeps-trying promise for an unreachable source when auto-check is off", () => {
    const wire = flaky({ transportStreak: 9 });
    const web = wireToUi({ ...wire, autoCheck: false }, NOW).web;
    expect(web.state).toBe("unreachable");
    expect(web.healthLine).not.toMatch(/keeps trying|retry/i);
  });

  it("a long streak is plainly unreachable, not retrying", () => {
    const web = wireToUi(flaky({ transportStreak: 9 }), NOW).web;
    expect(web.state).toBe("unreachable");
  });
});

describe("wireToUi — a refused press", () => {
  // The contract's list, NOT a copy of it: this used to be a hand-maintained array that had
  // drifted in both directions — it carried `invalid-manifest`, which no press is ever refused
  // with, and nothing tied it to the engine, so a new refusal code would have shipped with no
  // sentence and a green suite.
  const REFUSAL_CODES = UPDATE_PRESS_REFUSAL_CODES;

  it("is null when the server refused nothing", () => {
    expect(wireToUi(fullWire(), NOW).pressRefusal).toBeNull();
  });

  it("maps every refusal code to its own sentence and keeps the machine evidence", () => {
    const seen = new Set<string>();
    for (const code of REFUSAL_CODES) {
      const ui = wireToUi(
        fullWire({ pressRefusal: { code, raw: "/opt/app/bin", params: {} } }),
        NOW,
      ).pressRefusal;
      expect(ui?.code).toBe(code);
      expect(ui?.raw).toBe("/opt/app/bin");
      expect(ui?.sentence.length).toBeGreaterThan(0);
      seen.add(ui?.sentence ?? "");
    }
    expect(seen.size).toBe(REFUSAL_CODES.length); // no two refusals read the same
  });

  // The two truths the engine used to conflate. «Nothing newer» is only honest when a source
  // actually answered; when nobody did, re-checking — not re-pressing — is the way out.
  it("separates «nothing newer» from «nobody answered», and points each at its own action", () => {
    const noUpdate = wireToUi(
      fullWire({ pressRefusal: { code: "no-update", raw: null, params: {} } }),
      NOW,
    ).pressRefusal;
    const unreachable = wireToUi(
      fullWire({ pressRefusal: { code: "sources-unreachable", raw: null, params: {} } }),
      NOW,
    ).pressRefusal;
    expect(noUpdate?.sentence).not.toBe(unreachable?.sentence);
    expect(noUpdate?.action).toBe("install");
    expect(unreachable?.action).toBe("check");
  });

  it("interpolates refusal params into the sentence instead of shipping prose", () => {
    const ui = wireToUi(
      fullWire({
        pressRefusal: {
          code: "node-too-old",
          raw: null,
          params: { required: ">=22.12", running: "20.11.0" },
        },
      }),
      NOW,
    ).pressRefusal;
    expect(ui?.sentence).toContain(">=22.12");
    expect(ui?.sentence).toContain("20.11.0");
    expect(ui?.raw).toBeNull();
  });

  it("falls back to the generic sentence for an unknown code", () => {
    const ui = wireToUi(
      fullWire({ pressRefusal: { code: "weird", raw: null, params: {} } }),
      NOW,
    ).pressRefusal;
    expect(ui?.sentence).toBe("Something went wrong.");
  });

  // The store leans on this to keep a refusal from being toasted on top of the hero that
  // already states it.
  it("isPressRefusalCode knows exactly the codes the hero states inline", () => {
    for (const code of REFUSAL_CODES) expect(isPressRefusalCode(code)).toBe(true);
    expect(isPressRefusalCode("not-connected")).toBe(false);
    expect(isPressRefusalCode(undefined)).toBe(false);
  });
});

describe("wireToUi — source cards", () => {
  it("an ok source is working with a probe line", () => {
    const ui = wireToUi(fullWire(), NOW);
    expect(ui.web.working).toBe(true);
    expect(ui.web.state).toBe("ok");
    expect(ui.web.lastResult?.line).toBe("2 hours ago · 200 OK · 41 ms");
    expect(ui.git.lastResult?.line).toBe("2 hours ago · ls-remote OK · 320 ms");
  });

  it("a disabled source is off and not working", () => {
    const ui = wireToUi(fullWire({ web: webWire({ enabled: false }) }), NOW);
    expect(ui.web.state).toBe("disabled");
    expect(ui.web.working).toBe(false);
    expect(ui.web.healthLine).toBe("Turned off");
  });

  // §4: `probing` is the request, not its answer — a check must not flip a healthy source to
  // "not working" for its duration (that mounted the whole sources section on every check).
  it("a probing source whose LAST verdict was ok is still working", () => {
    const ui = wireToUi(fullWire({ git: gitWire({ probing: true }) }), NOW);
    expect(ui.git.state).toBe("probing");
    expect(ui.git.working).toBe(true);
  });

  it("a probing source with no verdict yet (first ever check) is NOT working", () => {
    const ui = wireToUi(fullWire({ git: gitWire({ probing: true, lastResult: null }) }), NOW);
    expect(ui.git.state).toBe("probing");
    expect(ui.git.working).toBe(false);
  });

  it("a probing source whose last verdict FAILED is NOT working", () => {
    const ui = wireToUi(
      fullWire({
        git: gitWire({
          probing: true,
          lastResult: {
            outcome: "fail",
            at: NOW - MIN,
            class: "answered",
            code: "git-access-denied",
            latencyMs: 30,
            raw: "403",
          },
        }),
      }),
      NOW,
    );
    expect(ui.git.state).toBe("probing");
    expect(ui.git.working).toBe(false);
  });

  it("a paused source surfaces the lockout sentence", () => {
    const ui = wireToUi(fullWire({ git: gitWire({ paused: true, authFails: 2 }) }), NOW);
    expect(ui.git.state).toBe("paused");
    expect(ui.git.healthLine).toContain("Paused");
  });

  it("an answered failure is errored with the failure sentence", () => {
    const ui = wireToUi(
      fullWire({
        web: webWire({
          lastResult: {
            outcome: "fail",
            at: NOW - MIN,
            class: "answered",
            code: "http-401",
            latencyMs: 30,
            raw: "401 Unauthorized",
          },
        }),
      }),
      NOW,
    );
    expect(ui.web.state).toBe("errored");
    expect(ui.web.healthLine).toBe("Sign-in required — the credentials were rejected.");
  });

  it("a long transport streak is unreachable", () => {
    const ui = wireToUi(
      fullWire({
        git: gitWire({
          transportStreak: 5,
          failingSince: NOW - 5 * HOUR,
          lastResult: {
            outcome: "fail",
            at: NOW - MIN,
            class: "transport",
            code: "timeout",
            latencyMs: null,
            raw: "ETIMEDOUT",
          },
        }),
      }),
      NOW,
    );
    expect(ui.git.state).toBe("unreachable");
    expect(ui.git.healthLine).toContain("5 hours ago");
  });

  it("maps git ssh credential metadata", () => {
    const ui = wireToUi(
      fullWire({
        git: gitWire({
          authVia: "ssh",
          sshCred: {
            fingerprint: "SHA256:abc",
            keyType: "ed25519",
            savedAt: NOW - 3 * DAY,
            origin: "generate",
          },
        }),
      }),
      NOW,
    );
    expect(ui.git.sshCred).toEqual({
      fingerprint: "SHA256:abc",
      keyType: "ed25519",
      savedAgo: "3 days ago",
      origin: "generate",
    });
  });
});

describe("wireToUi — hero composition", () => {
  it("a live run wins the hero (running)", () => {
    const ui = wireToUi(
      fullWire({
        run: {
          targetVersion: "1.4.2",
          fromVersion: "1.4.1",
          phase: "flip",
          pct: 0,
          log: [{ at: NOW, tone: "ok", code: "run.flipped", params: {} }],
          error: null,
        },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("running");
    if (ui.status.phase === "running") {
      expect(ui.status.run.phase).toBe("install"); // flip → install (sw-kit vocabulary)
      expect(ui.status.run.phaseLabel).toBe("Installing");
      expect(ui.status.run.log[0]?.text).toBe("new version in place · pointer written");
    }
    expect(ui.run?.phase).toBe("install");
  });

  // The whole point of FIX 1: the server KEEPS the run object after a failure, so
  // `run !== null ⇒ running` rendered a dead run as a spinner with «Приложение перезапустится
  // само», no reason and no button — and F5 could not clear it, because the run is server state.
  it("a FAILED run is its own hero state, never `running`", () => {
    const ui = wireToUi(
      fullWire({
        run: {
          targetVersion: "1.4.2",
          fromVersion: "1.4.1",
          phase: "failed",
          pct: 40,
          log: [{ at: NOW, tone: "err", code: "run.failed", params: { code: "download-failed" } }],
          error: { code: "download-failed", raw: "HTTP 404", params: {} },
        },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("run-failed");
    if (ui.status.phase === "run-failed") {
      expect(ui.status.run.error?.title).toBe("The update could not be downloaded.");
      expect(ui.status.run.error?.detail).toBe("HTTP 404");
      expect(ui.status.run.error?.hint.length).toBeGreaterThan(0);
      expect(ui.status.run.log[0]?.text).toContain("The update could not be downloaded.");
    }
  });

  it("every run-failure code the engine emits titles as itself, not the generic sentence", () => {
    for (const code of APPLY_FAILURE_CODES) {
      const ui = wireToUi(
        fullWire({
          run: {
            targetVersion: "1.4.2",
            fromVersion: "1.4.1",
            phase: "failed",
            pct: 0,
            log: [],
            error: { code, raw: null, params: {} },
          },
        }),
        NOW,
      );
      expect(ui.run?.error?.title).toBe(applyFailureSentence(code));
      expect(ui.run?.error?.title).not.toBe("Something went wrong.");
    }
  });

  // THE point of the `checking` wire flag: a background round must not blank what the hero knows.
  // It used to arrive as a hero PHASE, which replaced the `available` status for the whole round —
  // «Доступна vX» gone, the release-notes section unmounted, the sidebar pill vanished, all of it
  // returning when the tick settled.
  it("a check in flight is reported WITHOUT disturbing the hero's release", () => {
    const offered = { status: { phase: "available" as const, release: releaseWire() } };
    const checking = wireToUi(fullWire({ ...offered, checking: true }), NOW);
    expect(checking.checking).toBe(true);
    expect(checking.status.phase).toBe("available");
    expect(checking.release?.version).toBe(releaseWire().version);
    expect(wireToUi(fullWire(offered), NOW).checking).toBe(false);
  });

  // Absent on a server older than the field — an open tab talks to both during an update.
  it("treats a missing `checking` field as not checking", () => {
    const wire = fullWire();
    const { checking: _dropped, ...withoutField } = wire;
    expect(wireToUi(withoutField as typeof wire, NOW).checking).toBe(false);
  });

  it("an available status maps the release and populates state.release", () => {
    const ui = wireToUi(fullWire({ status: { phase: "available", release: releaseWire() } }), NOW);
    expect(ui.status.phase).toBe("available");
    expect(ui.release?.version).toBe("1.4.2");
  });

  it("attention maps the code to a title + message", () => {
    const ui = wireToUi(fullWire({ status: { phase: "attention", code: "needs-setup" } }), NOW);
    expect(ui.status.phase).toBe("attention");
    if (ui.status.phase === "attention") expect(ui.status.attention.code).toBe("needs-setup");
  });

  it("a failed apply (no run, no available) becomes apply-failed with the reason", () => {
    const ui = wireToUi(
      fullWire({
        status: { phase: "never-checked" },
        lastApply: {
          targetVersion: "1.4.2",
          fromVersion: "1.4.1",
          outcome: "failed",
          reasonCode: "archive-integrity",
          at: NOW - MIN,
        },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("apply-failed");
    if (ui.status.phase === "apply-failed") {
      expect(ui.status.lastApply.reason).toBe(
        "The downloaded file was corrupted (checksum mismatch).",
      );
      expect(ui.status.lastApply.reasonRaw).toBeNull();
    }
  });

  it("an unknown failed-apply reason carries the raw code", () => {
    const ui = wireToUi(
      fullWire({
        status: { phase: "never-checked" },
        lastApply: {
          targetVersion: "1.4.2",
          fromVersion: "1.4.1",
          outcome: "failed",
          reasonCode: "brand-new-code",
          at: NOW - MIN,
        },
      }),
      NOW,
    );
    if (ui.status.phase === "apply-failed") {
      expect(ui.status.lastApply.reason).toBe("Something went wrong.");
      expect(ui.status.lastApply.reasonRaw).toBe("brand-new-code");
    }
  });
});

// ── G33: the never-checked source, and what a check is allowed to reach ──────────
//
// Two separate defects lived here. `idle` (nothing has been asked of this source yet — by design,
// nothing probes at boot) was projected onto the SAME amber "needs setup" health as a paused or
// rejected source, so a FRESH INSTALL opened on two warning cards whose own bodies said no setup
// was needed. And the hero's «Check now» was gated on `working` — "the last check succeeded" —
// which on a fresh install is false for every source, disabling the one button that would fix it.

describe("wireToUi — a source nothing has asked anything of yet", () => {
  const untouched = () =>
    fullWire({ git: gitWire({ lastResult: null }), web: webWire({ lastResult: null }) });

  it("is `idle`, whose health is neutral — NOT «needs setup»", () => {
    const ui = wireToUi(untouched(), NOW);
    for (const source of [ui.git, ui.web]) {
      expect(source.state).toBe("idle");
      expect(sourceHealth(source.state)).toBe("unchecked");
      expect(source.healthLine).toBe("Not checked yet");
    }
  });

  it("is CHECKABLE even though it is not yet working — for both sources alike", () => {
    const ui = wireToUi(untouched(), NOW);
    // The projection reads the STATE, never the kind: git and web must behave identically.
    expect(ui.git.working).toBe(false);
    expect(ui.web.working).toBe(false);
    expect(ui.git.checkable).toBe(true);
    expect(ui.web.checkable).toBe(true);
    expect(anySourceCheckable(ui)).toBe(true);
    expect(anySourceWorks(ui)).toBe(false);
  });

  it("is not checkable once the user switches it off, pauses it, or the build omits it", () => {
    const off = wireToUi(fullWire({ web: webWire({ enabled: false }) }), NOW);
    expect(off.web.checkable).toBe(false);
    const paused = wireToUi(fullWire({ web: webWire({ paused: true }) }), NOW);
    expect(paused.web.checkable).toBe(false);
    const absent = wireToUi(fullWire({ web: webWire({ offered: false }) }), NOW);
    expect(absent.web.checkable).toBe(false);
  });

  it("leaves nothing checkable when every source is unusable", () => {
    const ui = wireToUi(
      fullWire({ git: gitWire({ enabled: false }), web: webWire({ paused: true }) }),
      NOW,
    );
    expect(anySourceCheckable(ui)).toBe(false);
  });

  it("a source that HAS answered keeps its settled health", () => {
    const ui = wireToUi(fullWire(), NOW);
    expect(sourceHealth(ui.web.state)).toBe("ok");
    expect(sourceHealth("paused")).toBe("needs-setup");
    expect(sourceHealth("errored")).toBe("needs-setup");
    expect(sourceHealth("unreachable")).toBe("unreachable");
    // F17 stands: a short transport streak is not a live probe.
    expect(sourceHealth("retrying")).toBe("unreachable");
  });
});

describe("wireToUi — a request that is in flight right now", () => {
  it("outranks every settled fact, so a press is never silent", () => {
    const ui = wireToUi(
      fullWire({
        web: webWire({
          probing: true,
          // Even with a failure on the record, what is TRUE right now is that we are asking again.
          lastResult: {
            outcome: "fail",
            at: NOW - MIN,
            class: "answered",
            code: "http-404",
            latencyMs: 12,
            raw: "404",
          },
        }),
      }),
      NOW,
    );
    expect(ui.web.state).toBe("probing");
    expect(sourceHealth(ui.web.state)).toBe("probing");
    expect(ui.web.healthLine).toBe("Checking the source…");
  });

  it("does not survive a switched-off source (nothing is being asked)", () => {
    const ui = wireToUi(fullWire({ web: webWire({ enabled: false, probing: true }) }), NOW);
    expect(ui.web.state).toBe("disabled");
  });
});
