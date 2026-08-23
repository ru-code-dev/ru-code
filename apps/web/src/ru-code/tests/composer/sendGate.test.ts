// ru-code: the shared send-block predicate both send entry points consult
// (ChatView.onSend and the collapsed-mobile button), driven with the REAL
// compaction derivation so the reload-proof block is a composite, not a
// hand-fed boolean.
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { CONTEXT_COMPACTION_TASK_PREFIX, QWEN_KIND } from "@ru-code/branding";
import { describe, expect, it } from "vite-plus/test";

import { isQwenRunningTurn, shouldBlockComposerSend } from "../../composer/sendGate";
import { deriveIsCompactingContext } from "../../workLog/contextCompaction";

const OPEN = {
  isSendBusy: false,
  isConnecting: false,
  isCompactingContext: false,
} as const;

describe("shouldBlockComposerSend", () => {
  it("nothing blocking → send allowed", () => {
    expect(shouldBlockComposerSend(OPEN)).toBe(false);
  });

  it.each([
    ["isSendBusy", { ...OPEN, isSendBusy: true }],
    ["isConnecting", { ...OPEN, isConnecting: true }],
    ["isCompactingContext", { ...OPEN, isCompactingContext: true }],
    ["isEnvironmentUnavailable", { ...OPEN, isEnvironmentUnavailable: true }],
    ["isRunningTurn", { ...OPEN, isRunningTurn: true }],
    ["sendInFlight", { ...OPEN, sendInFlight: true }],
    ["no sendable content", { ...OPEN, hasSendableContent: false }],
    ["isSendDisabled", { ...OPEN, isSendDisabled: true }],
    ["noProviderAvailable", { ...OPEN, noProviderAvailable: true }],
    ["threadDetailLoading", { ...OPEN, threadDetailLoading: true }],
  ] as const)("%s blocks the send", (_label, input) => {
    expect(shouldBlockComposerSend(input)).toBe(true);
  });

  it("optional signals omitted do not block (parked-on-user keeps Send available)", () => {
    expect(
      shouldBlockComposerSend({ ...OPEN, isRunningTurn: false, hasSendableContent: true }),
    ).toBe(false);
  });

  it("composite: a running compaction derived from persisted activities blocks the send", () => {
    const progress: OrchestrationThreadActivity = {
      id: EventId.make("send-gate-progress"),
      createdAt: "2026-03-09T00:00:00.000Z",
      kind: "task.progress",
      summary: "Обновление рассуждений",
      tone: "info",
      payload: {
        taskId: `${CONTEXT_COMPACTION_TASK_PREFIX}gate-1`,
        detail: "Идет сжатие контекста…",
      },
      turnId: null,
    };
    const completed: OrchestrationThreadActivity = {
      ...progress,
      id: EventId.make("send-gate-completed"),
      createdAt: "2026-03-09T00:00:01.000Z",
      kind: "task.completed",
      payload: {
        taskId: `${CONTEXT_COMPACTION_TASK_PREFIX}gate-1`,
        status: "completed",
        detail: "Готово",
      },
    };
    expect(
      shouldBlockComposerSend({
        ...OPEN,
        isCompactingContext: deriveIsCompactingContext([progress]),
      }),
    ).toBe(true);
    expect(
      shouldBlockComposerSend({
        ...OPEN,
        isCompactingContext: deriveIsCompactingContext([progress, completed]),
      }),
    ).toBe(false);
  });
});

const RUNNING = {
  providerDriver: QWEN_KIND,
  phase: "running",
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasPendingPlanApproval: false,
} as const;

describe("isQwenRunningTurn — the qwen-only streaming guard", () => {
  it("blocks a send while a qwen turn streams", () => {
    expect(isQwenRunningTurn(RUNNING)).toBe(true);
  });

  it("never fires for another driver — they steer instead of aborting", () => {
    for (const driver of ["claude", "codex", "opencode", "cursor", "grok"]) {
      expect(isQwenRunningTurn({ ...RUNNING, providerDriver: driver })).toBe(false);
    }
    expect(isQwenRunningTurn({ ...RUNNING, providerDriver: null })).toBe(false);
    expect(isQwenRunningTurn({ ...RUNNING, providerDriver: undefined })).toBe(false);
  });

  it("never fires outside the running phase", () => {
    for (const phase of ["ready", "connecting", "disconnected"]) {
      expect(isQwenRunningTurn({ ...RUNNING, phase })).toBe(false);
    }
  });

  it.each([
    ["held approval", { pendingApprovalCount: 1 }],
    ["user-input question", { pendingUserInputCount: 1 }],
    ["plan approval", { hasPendingPlanApproval: true }],
  ] as const)("releases the guard while parked on the user: %s", (_label, parked) => {
    // Parked sessions still report phase "running", but nothing is streaming and
    // the send is what settles the parked Deferred server-side.
    expect(isQwenRunningTurn({ ...RUNNING, ...parked })).toBe(false);
  });

  it("composes into the gate exactly as ChatView.onSend calls it", () => {
    expect(shouldBlockComposerSend({ ...OPEN, isRunningTurn: isQwenRunningTurn(RUNNING) })).toBe(
      true,
    );
    expect(
      shouldBlockComposerSend({
        ...OPEN,
        isRunningTurn: isQwenRunningTurn({ ...RUNNING, pendingApprovalCount: 1 }),
      }),
    ).toBe(false);
  });
});
