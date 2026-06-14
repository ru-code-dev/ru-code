// ru-fork: unit tests for the supervisor's pure probe-decision logic — the rules
// that decide WHICH instances get probed (watch scope, mandatory-first probe,
// per-transport due intervals) and which a manual recheck targets. These encode
// the monitoring redesign's contract, so they are tested in isolation from the
// (network-bound) probe itself.

import {
  instanceInWatched,
  instanceMatchesRecheck,
  isProbeDue,
  isSweepDue,
  nextStatus,
  type SupervisorInstance,
} from "../../../src/ru-fork/mcp/McpSupervisor.ts";
import type { ProbeResult } from "@ru-fork/mcp-core";
import { describe, expect, it } from "vitest";

const NOW = 10_000_000;
const MIN = 60_000;

function makeInstance(overrides: {
  refs: ReadonlyArray<string>;
  transport?: "stdio" | "http";
  checkedAtMs?: number | null;
}): SupervisorInstance {
  const transport = overrides.transport ?? "stdio";
  return {
    hash: "hash",
    configKey: "configKey",
    resolved:
      transport === "stdio"
        ? { transport: "stdio", command: "npx", args: [], env: {}, cwd: "/probe" }
        : { transport: "http", httpUrl: "https://x", headers: {} },
    refs: new Set(overrides.refs),
    status: "online",
    message: null,
    latencyMs: null,
    checkedAt: null,
    // Honor an explicit `null` (never probed); only default when omitted.
    checkedAtMs: "checkedAtMs" in overrides ? overrides.checkedAtMs ?? null : NOW - MIN,
    discoveredTools: [],
    consecutiveFailures: 0,
  };
}

describe("instanceInWatched", () => {
  it("matches a project ref whose project is watched", () => {
    const instance = makeInstance({ refs: ["proj1:srv"] });
    expect(instanceInWatched(instance, new Set(["proj1"]))).toBe(true);
    expect(instanceInWatched(instance, new Set(["proj2"]))).toBe(false);
  });

  it("never treats a catalog-only ref as belonging to a watched project", () => {
    // Watch sets are real project ids, never the synthetic "catalog" scope.
    const instance = makeInstance({ refs: ["catalog:srv"] });
    expect(instanceInWatched(instance, new Set(["proj1", "proj2"]))).toBe(false);
  });

  it("matches when ANY ref's project is watched (shared instance)", () => {
    const instance = makeInstance({ refs: ["catalog:srv", "proj1:srv", "proj2:srv"] });
    expect(instanceInWatched(instance, new Set(["proj2"]))).toBe(true);
  });
});

describe("isProbeDue", () => {
  it("is NOT auto-due when never probed (no probing on load — manual/change only)", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], checkedAtMs: null });
    expect(isProbeDue(instance, NOW, 5 * MIN, 10 * MIN)).toBe(false);
  });

  it("never auto-reprobes when the transport interval is 0", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], checkedAtMs: NOW - 999 * MIN });
    expect(isProbeDue(instance, NOW, 0, 0)).toBe(false);
  });

  it("uses the LOCAL interval for stdio", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], transport: "stdio", checkedAtMs: NOW - 6 * MIN });
    expect(isProbeDue(instance, NOW, 5 * MIN, 30 * MIN)).toBe(true);
    expect(isProbeDue(instance, NOW, 30 * MIN, 5 * MIN)).toBe(false);
  });

  it("uses the REMOTE interval for http", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], transport: "http", checkedAtMs: NOW - 6 * MIN });
    expect(isProbeDue(instance, NOW, 30 * MIN, 5 * MIN)).toBe(true);
    expect(isProbeDue(instance, NOW, 5 * MIN, 30 * MIN)).toBe(false);
  });
});

describe("isSweepDue", () => {
  it("never auto-probes a never-checked instance (no probing on load)", () => {
    const instance = makeInstance({ refs: ["catalog:srv"], checkedAtMs: null });
    expect(isSweepDue(instance, new Set(["other"]), NOW, 5 * MIN, 10 * MIN)).toBe(false);
    expect(isSweepDue(instance, null, NOW, 5 * MIN, 10 * MIN)).toBe(false);
  });

  it("skips an already-checked instance outside the watch scope", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], checkedAtMs: NOW - 999 * MIN });
    expect(isSweepDue(instance, new Set(["proj2"]), NOW, 5 * MIN, 10 * MIN)).toBe(false);
  });

  it("reprobes a watched, due instance", () => {
    const instance = makeInstance({ refs: ["proj1:srv"], checkedAtMs: NOW - 6 * MIN });
    expect(isSweepDue(instance, new Set(["proj1"]), NOW, 5 * MIN, 10 * MIN)).toBe(true);
  });

  it("falls back to plain due-gating when nothing is watched yet (null)", () => {
    const fresh = makeInstance({ refs: ["proj1:srv"], checkedAtMs: NOW - 1 * MIN });
    expect(isSweepDue(fresh, null, NOW, 5 * MIN, 10 * MIN)).toBe(false);
    const stale = makeInstance({ refs: ["proj1:srv"], checkedAtMs: NOW - 6 * MIN });
    expect(isSweepDue(stale, null, NOW, 5 * MIN, 10 * MIN)).toBe(true);
  });
});

describe("instanceMatchesRecheck", () => {
  const shared = makeInstance({ refs: ["catalog:fs", "proj1:fs", "proj2:fs"], transport: "stdio" });

  it("matches a catalog recheck (serverId only) via the catalog ref", () => {
    expect(instanceMatchesRecheck(shared, { serverId: "fs" })).toBe(true);
    expect(instanceMatchesRecheck(shared, { serverId: "other" })).toBe(false);
  });

  it("matches a project recheck (projectId only)", () => {
    expect(instanceMatchesRecheck(shared, { projectId: "proj1" })).toBe(true);
    expect(instanceMatchesRecheck(shared, { projectId: "proj3" })).toBe(false);
  });

  it("matches a single binding (projectId + serverId)", () => {
    expect(instanceMatchesRecheck(shared, { projectId: "proj2", serverId: "fs" })).toBe(true);
    expect(instanceMatchesRecheck(shared, { projectId: "proj2", serverId: "nope" })).toBe(false);
  });

  it("filters by transport", () => {
    expect(instanceMatchesRecheck(shared, { transport: "stdio" })).toBe(true);
    expect(instanceMatchesRecheck(shared, { transport: "http" })).toBe(false);
  });

  it("an empty filter matches everything", () => {
    expect(instanceMatchesRecheck(shared, {})).toBe(true);
  });
});

describe("nextStatus", () => {
  const online: ProbeResult = { status: "online", tools: [], latencyMs: 1 };
  const hardOffline: ProbeResult = { status: "offline", tools: [], latencyMs: 1, message: "ENOENT" };
  const timeoutOffline: ProbeResult = {
    status: "offline",
    tools: [],
    latencyMs: 1,
    message: "timeout",
    timedOut: true,
  };

  it("online resets to online + zero failures", () => {
    expect(nextStatus(online, 2)).toEqual({ status: "online", consecutiveFailures: 0 });
  });

  it("a HARD failure is offline (red) immediately — no degraded buffer", () => {
    expect(nextStatus(hardOffline, 0)).toEqual({ status: "offline", consecutiveFailures: 1 });
  });

  it("a TIMEOUT stays degraded (amber) until the 3rd consecutive, then offline", () => {
    expect(nextStatus(timeoutOffline, 0)).toEqual({ status: "degraded", consecutiveFailures: 1 });
    expect(nextStatus(timeoutOffline, 1)).toEqual({ status: "degraded", consecutiveFailures: 2 });
    expect(nextStatus(timeoutOffline, 2)).toEqual({ status: "offline", consecutiveFailures: 3 });
  });
});
