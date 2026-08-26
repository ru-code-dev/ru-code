// ru-code (agentic-flow wave, P3e): the BUTTON RULE, as ruled.
//
// Owner ruling 2026-08-27: "bg-agent CARDS gain a stop icon-button VISIBLE ONLY
// while that agent is running (bg agents only) … on app crash / acp crash /
// composer hard stop, bg rows flip status 'aborted' — CARD STAYS, only the
// button disappears (button rule: bg && running)."
//
// Both halves matter and both are load-bearing:
//   · foreground — a foreground subagent has no individually addressable handle
//     upstream at all (it lives and dies inside its turn), so a stop there would
//     be a control with nothing behind it;
//   · settled — qwen answers a cancel for a settled task with a typed no-op
//     (`{cancelled:false, reason:'not_running'}`, acpAgent.ts:9415), so the
//     button would do nothing while implying it could.
import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";

import { canStopAgent } from "../../agents/AgentStopButton";

const agent = (overrides: Partial<RuntimeSubagent>): RuntimeSubagent =>
  ({
    id: "general-purpose-call-1",
    kind: "subagent",
    isBackgrounded: false,
    title: "Audit the config",
    role: "general-purpose",
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    startedAt: "2026-05-01T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  }) satisfies RuntimeSubagent;

describe("canStopAgent — the ruled button rule", () => {
  it("shows for a RUNNING background agent", () => {
    expect(canStopAgent(agent({ isBackgrounded: true, status: "running" }))).toBe(true);
  });

  it("shows while a background agent is pending or waiting — still live work", () => {
    expect(canStopAgent(agent({ isBackgrounded: true, status: "pending" }))).toBe(true);
    expect(canStopAgent(agent({ isBackgrounded: true, status: "waiting" }))).toBe(true);
  });

  it("hides for a FOREGROUND agent, whatever its status", () => {
    for (const status of ["running", "pending", "waiting"] as const) {
      expect(canStopAgent(agent({ isBackgrounded: false, status }))).toBe(false);
    }
  });

  it("hides once a background agent settles — the card stays, the button goes", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      expect(canStopAgent(agent({ isBackgrounded: true, status }))).toBe(false);
    }
  });

  it("hides for a PAUSED (idle) background agent — nothing is running to stop", () => {
    // qwen's paused → our `idle` (ClaudeAdapter.ts:993's mapping). The task is
    // frozen until the model sends it a message (research §15.2); cancelling it
    // is `abandon()`, a different action, and the ruling scopes the button to
    // running.
    expect(canStopAgent(agent({ isBackgrounded: true, status: "idle" }))).toBe(false);
  });
});
