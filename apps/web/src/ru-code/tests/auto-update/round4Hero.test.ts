// ru-code: round 4 — the hero's two truthfulness rules and the SW page's reachable surface.

import { describe, expect, it } from "vite-plus/test";

import type { AutoUpdateWireState, LastApplyWire } from "@t3tools/contracts";

import { wireToUi } from "../../auto-update-ui/store/wireToUi";
import { updatingFragment } from "../../auto-update-ui/sw-kit/updatingPage";

const NOW = 1_760_000_000_000;

const source = () => ({
  enabled: true,
  offered: true,
  url: "https://releases.example.com/",
  paused: false,
  authFails: 0,
  transportStreak: 0,
  failingSince: null,
  lastResult: null,
  probing: false,
});

const wire = (over: Partial<AutoUpdateWireState> = {}): AutoUpdateWireState =>
  ({
    currentVersion: "1.4.1",
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

const failedApply = (at: number): LastApplyWire => ({
  targetVersion: "1.4.2",
  fromVersion: "1.4.1",
  outcome: "failed",
  reasonCode: "spawn-failed",
  at,
});

const okAt = (at: number) => ({ outcome: "ok" as const, at, latencyMs: 12, raw: "200 OK" });

// ── AU-16 / #5: a later successful check answers a failed apply ───────────────────

describe("the apply-failed hero steps aside once a check has answered it", () => {
  it("stays while nothing has been checked since the failure", () => {
    const ui = wireToUi(wire({ lastApply: failedApply(NOW - 60_000) }), NOW);
    expect(ui.status.phase).toBe("apply-failed");
  });

  it("stays when the only OK result PREDATES the failure", () => {
    // The defect this half guards: comparing "is there any OK result" instead of "since when"
    // would clear the hero using evidence older than the thing it describes.
    const ui = wireToUi(
      wire({
        lastApply: failedApply(NOW - 60_000),
        web: { ...source(), cred: null, lastResult: okAt(NOW - 120_000) },
        status: { phase: "up-to-date", lastCheckedAt: NOW - 120_000 },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("apply-failed");
  });

  it("steps aside once a check has succeeded AFTER the failure", () => {
    // It used to be written once at boot and cleared by nothing at all, so one failed apply
    // painted the settings page destructive-red on every visit for the life of the process —
    // even after a successful check had proved the app was up to date.
    const ui = wireToUi(
      wire({
        lastApply: failedApply(NOW - 60_000),
        web: { ...source(), cred: null, lastResult: okAt(NOW - 10_000) },
        status: { phase: "up-to-date", lastCheckedAt: NOW - 10_000 },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("up-to-date");
    // The RECORD is untouched — only the hero moves on.
    expect(ui.lastApply?.outcome).toBe("failed");
  });

  it("a live run still outranks everything", () => {
    const ui = wireToUi(
      wire({
        lastApply: failedApply(NOW - 60_000),
        run: {
          targetVersion: "1.4.2",
          fromVersion: "1.4.1",
          phase: "download",
          pct: 12,
          log: [],
          error: null,
        },
      }),
      NOW,
    );
    expect(ui.status.phase).toBe("running");
  });
});

// ── T4 / T12 / AU-51: the SW updating page renders only what it can reach ─────────

describe("the SW updating fragment", () => {
  const vm = {
    targetVersion: "1.4.2",
    phase: "restart" as const,
    pct: 0,
    log: [{ time: "09:44:12", tone: "act" as const, text: "server is restarting" }],
    locale: "ru" as const,
  };

  it("renders the four steps the in-app timeline renders — no more", () => {
    const html = updatingFragment(vm);
    for (const label of ["Скачивание", "Проверка", "Установка", "Перезапуск"]) {
      expect(html).toContain(label);
    }
    // The strip grew a fifth dot exactly at the handover, on two surfaces whose own headers say
    // they must read alike because the user crosses from one to the other mid-update.
    expect(html).not.toContain("Подключение");
  });

  it("carries no retry action — nothing has ever handled one", () => {
    expect(updatingFragment(vm)).not.toContain('data-action="retry"');
  });

  it("escapes the version it interpolates", () => {
    const html = updatingFragment({ ...vm, targetVersion: '1.0<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
