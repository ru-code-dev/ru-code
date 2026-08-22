// ru-code: the boot-state builder (engine/initialState.ts). Everything derives
// from persisted config — NO probes, NO network. Covers `offered` = url !== "",
// the credential-metadata assembly, autoCheck-gated nextCheckAt, lastApply
// passthrough, and each §3 hero-seed rule off real persisted config.

import { describe, expect, it } from "@effect/vitest";

import type { LastApplyWire, UpdateEnvFactsWire } from "@t3tools/contracts";

import {
  defaultConfig,
  type AutoUpdateConfig,
  type SourceConfig,
} from "../../auto-update/engine/configStore.ts";
import { buildInitialState, type CredMetaForState } from "../../auto-update/engine/initialState.ts";

const facts: UpdateEnvFactsWire = {
  installDir: "/opt/app",
  entryJs: "/opt/app/cli.js",
  pid: 42,
  port: 8080,
  address: "127.0.0.1:8080",
  canApply: true,
  blockReason: null,
};

const noCreds: CredMetaForState = {
  git: { authVia: "ambient", httpsCred: null, sshCred: null },
  web: { cred: null },
};

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    enabled: true,
    paused: false,
    authFails: 0,
    transportStreak: 0,
    failingSince: null,
    lastResult: null,
    ...over,
  };
}

function config(over: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return { ...defaultConfig(17), ...over };
}

function build(params: {
  config?: AutoUpdateConfig;
  gitUrl?: string;
  webUrl?: string;
  credMeta?: CredMetaForState;
  nextCheckAt?: number | null;
  lastApply?: LastApplyWire | null;
}) {
  return buildInitialState({
    config: params.config ?? config(),
    facts,
    currentVersion: "1.0.0",
    gitUrl: params.gitUrl ?? "git-url",
    webUrl: params.webUrl ?? "web-url",
    credMeta: params.credMeta ?? noCreds,
    nextCheckAt: params.nextCheckAt ?? 999,
    lastApply: params.lastApply ?? null,
  });
}

describe("buildInitialState — wire assembly", () => {
  it("offered = url !== '' per source", () => {
    const state = build({ gitUrl: "", webUrl: "web-url" });
    expect(state.git.offered).toBe(false);
    expect(state.web.offered).toBe(true);
    expect(state.git.url).toBe("");
  });

  it("carries per-source persisted counters and switches", () => {
    const state = build({
      config: config({
        sources: {
          git: source({
            enabled: false,
            paused: true,
            authFails: 2,
            transportStreak: 5,
            failingSince: 100,
          }),
          web: source(),
        },
      }),
    });
    expect(state.git.enabled).toBe(false);
    expect(state.git.paused).toBe(true);
    expect(state.git.authFails).toBe(2);
    expect(state.git.transportStreak).toBe(5);
    expect(state.git.failingSince).toBe(100);
  });

  it("assembles git credential metadata + authVia and web cred", () => {
    const credMeta: CredMetaForState = {
      git: {
        authVia: "ssh",
        httpsCred: null,
        sshCred: {
          fingerprint: "SHA256:x",
          keyType: "ed25519",
          savedAt: 1,
          origin: "file",
        },
      },
      web: { cred: { username: "u", savedAt: 2 } },
    };
    const state = build({ credMeta });
    expect(state.git.authVia).toBe("ssh");
    expect(state.git.sshCred?.fingerprint).toBe("SHA256:x");
    expect(state.web.cred?.username).toBe("u");
  });

  it("run is always null; lastApply passes through; facts/notify/stamps mirror config", () => {
    const lastApply: LastApplyWire = {
      targetVersion: "2.0.0",
      fromVersion: "1.0.0",
      outcome: "failed",
      reasonCode: "sha-mismatch",
      at: 7,
    };
    const state = build({
      config: config({
        notified: { release: { version: "2.0.0", at: 555 }, problems: null },
        notify: { releasesMuted: true, problemsMuted: false },
      }),
      lastApply,
    });
    expect(state.run).toBe(null);
    expect(state.lastApply).toEqual(lastApply);
    expect(state.facts).toEqual(facts);
    expect(state.notify).toEqual({ releasesMuted: true, problemsMuted: false });
    expect(state.notified).toEqual({ release: { version: "2.0.0", at: 555 }, problems: null });
  });
});

describe("buildInitialState — autoCheck gates nextCheckAt", () => {
  it("autoCheck on → nextCheckAt taken from the engine-supplied value", () => {
    const state = build({ config: config({ autoCheck: true }), nextCheckAt: 12345 });
    expect(state.autoCheck).toBe(true);
    expect(state.nextCheckAt).toBe(12345);
  });

  it("autoCheck off → nextCheckAt null regardless of the supplied value", () => {
    const state = build({ config: config({ autoCheck: false }), nextCheckAt: 12345 });
    expect(state.autoCheck).toBe(false);
    expect(state.nextCheckAt).toBe(null);
  });
});

describe("buildInitialState — §3 hero seed rules", () => {
  it("available: persisted release newer than current", () => {
    const state = build({
      config: config({
        availableRelease: {
          version: "2.0.0",
          releasedAt: null,
          sizeBytes: null,
          sha256: "s",
          changelog: [],
          changelogTruncated: false,
          foundAt: 10,
        },
      }),
    });
    expect(state.status.phase).toBe("available");
  });

  it("up-to-date: a persisted ok lastResult, no newer release", () => {
    const state = build({
      config: config({
        sources: {
          git: source({ lastResult: { outcome: "ok", at: 900, latencyMs: null, raw: null } }),
          web: source(),
        },
      }),
    });
    expect(state.status).toEqual({ phase: "up-to-date", lastCheckedAt: 900 });
  });

  it("needs-setup: a paused source", () => {
    const state = build({
      config: config({ sources: { git: source({ paused: true }), web: source() } }),
    });
    expect(state.status).toEqual({ phase: "attention", code: "needs-setup" });
  });

  it("unreachable: only a persisted transport failure", () => {
    const state = build({
      config: config({
        sources: {
          git: source({
            lastResult: {
              outcome: "fail",
              at: 1,
              class: "transport",
              code: "dns",
              latencyMs: null,
              raw: null,
            },
          }),
          web: source(),
        },
      }),
    });
    expect(state.status).toEqual({ phase: "attention", code: "unreachable" });
  });

  it("sources-off: neither source offered", () => {
    const state = build({ gitUrl: "", webUrl: "" });
    expect(state.status).toEqual({ phase: "attention", code: "sources-off" });
  });

  it("never-checked: fresh install, both sources armed", () => {
    const state = build({});
    expect(state.status).toEqual({ phase: "never-checked" });
  });
});
