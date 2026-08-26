// ru-code (agentic-flow wave, FIX ROUND 2): the stop button, RENDERED — in the
// panel, not in isolation.
//
// `agentStopButton.test.ts` pins the RULE (`canStopAgent`) and nothing else. A
// rule nobody can reach is not a feature: the button is `null` unless it is ALSO
// handed an `environmentId` and a `threadId` (AgentStopButton.tsx:42), and those
// arrive as props threaded down through the panel. This file asserts the whole
// chain — model → panel → row → button — on the real components.
//
// WHAT THE OWNER'S LIVE TEST ACTUALLY SHOWED, stated because it changes what
// needs fixing: the rows still running were the ZOMBIES, and a zombie is not a
// background row (`isBackgrounded` is set only by the launch/poll producers), so
// `canStopAgent` was false for every one of them. The missing button was the
// zombie defect wearing a different hat, and FIX ROUND 2's single-row work is
// what restores it. These specs pin that outcome so it cannot silently regress.
//
// `renderToStaticMarkup` over the real component, the same pattern as
// `midTurnDeliveryMark.render.test.tsx`. `AgentStopButton` reads
// `RegistryContext` through `useAtomCommand`, which is a `useCallback` over a
// context read — safe to render without a provider, because the registry is only
// touched inside the click handler.
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "../../../components/AgentsPanel";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const THREAD_ID = ThreadId.make("thread-1");

const agent = (overrides: Partial<RuntimeSubagent>): RuntimeSubagent =>
  ({
    id: "general-purpose-5e6f7a8b",
    kind: "subagent",
    isBackgrounded: true,
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

const model = (overrides: Partial<AgentPanelModel>): AgentPanelModel => ({
  workflows: [],
  directAgents: [],
  runningCount: 1,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: true,
  liveCount: 1,
  ...overrides,
});

const renderPanel = (panelModel: AgentPanelModel) =>
  renderToStaticMarkup(
    <AgentsPanel model={panelModel} environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />,
  );

/** The button's own markup — `aria-label="Stop agent"` (AgentStopButton.tsx:50). */
const stopButtons = (markup: string) => markup.split('aria-label="Stop agent"').length - 1;

describe("the background stop button, in the panel", () => {
  it("a RUNNING background direct spawn renders exactly one stop button", () => {
    const markup = renderPanel(model({ directAgents: [agent({})] }));
    expect(stopButtons(markup)).toBe(1);
  });

  it("a settled background row keeps its card and loses its button (the ruling)", () => {
    // Owner ruling 2026-08-27: "CARD STAYS, only the button disappears".
    const markup = renderPanel(
      model({
        directAgents: [agent({ status: "completed", completedAt: "2026-05-01T00:01:00.000Z" })],
        runningCount: 0,
        settledCount: 1,
        liveCount: 0,
      }),
    );
    expect(markup).toContain("Audit the config");
    expect(stopButtons(markup)).toBe(0);
  });

  it("a running FOREGROUND row renders no stop button", () => {
    const markup = renderPanel(model({ directAgents: [agent({ isBackgrounded: false })] }));
    expect(stopButtons(markup)).toBe(0);
  });

  it("a background row inside a WORKFLOW PHASE is stoppable too", () => {
    // The gap this closes: `PhaseSection` and the unphased-member list rendered
    // their rows without the two ids, so a background row that reached either
    // one had a structurally invisible button — the panel's own comment asserted
    // "a background agent is never a workflow member", which is true of every
    // producer we ship TODAY (nothing on the poll path sets `parentAgentId`) and
    // is exactly the kind of fact that stops being true when a producer changes.
    // The invariant is now unconditional: every agent row the panel draws can be
    // stopped when `canStopAgent` says so.
    const member = agent({ id: "general-purpose-wf1", kind: "workflow_agent" });
    const markup = renderPanel(
      model({
        workflows: [
          {
            workflow: agent({
              id: "wf:1",
              kind: "workflow",
              title: "Migration",
              isBackgrounded: false,
              workflowName: "Migration",
            }),
            phases: [
              {
                index: 0,
                title: "Phase one",
                members: [member],
                state: "running",
                activeCount: 1,
                settledCount: 0,
              },
            ],
            unphasedMembers: [],
          },
        ],
      }),
    );
    expect(stopButtons(markup)).toBe(1);
  });

  it("a background row with no phase (an unphased workflow member) is stoppable too", () => {
    const member = agent({ id: "general-purpose-wf2", kind: "workflow_agent" });
    const markup = renderPanel(
      model({
        workflows: [
          {
            workflow: agent({
              id: "wf:2",
              kind: "workflow",
              title: "Migration",
              isBackgrounded: false,
              workflowName: "Migration",
            }),
            phases: [],
            unphasedMembers: [member],
          },
        ],
      }),
    );
    expect(stopButtons(markup)).toBe(1);
  });
});
