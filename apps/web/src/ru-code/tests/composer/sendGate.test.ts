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

// ru-code (mid-turn wave, phase 1 — BASELINE LOCK) ────────────────────────────
//
// The wave relaxes ONE condition: the qwen running-turn block, so a message
// typed during a live qwen turn is queued instead of refused. The OWNER RULING
// is that the COMPACTION lock is out of scope and must survive untouched
// (wave-midturn-plan.md, "OWNER RULING (scope)").
//
// Those two conditions sit in the same boolean OR chain (sendGate.ts:32 and
// :34), so a relax written as "stop blocking while a qwen turn runs" is one
// careless edit away from taking compaction with it — and NO existing spec
// distinguishes them, because until now the two were never true at once (the
// running-turn block made the composite unreachable). These pin the difference
// BEFORE the relax lands.
describe("mid-turn wave baseline — what the relax may and may not touch", () => {
  it("RELAXED (phase 3): a live qwen turn no longer blocks the send", () => {
    // WAS (phase 1): both of these expected `true`, and the spec said "a
    // phase-3 that relaxes the gate MUST flip this expectation deliberately —
    // it cannot drift silently." This is that deliberate flip.
    //
    // The predicate itself still reports a running qwen turn — that fact did
    // not change. What changed is that ChatView.onSend no longer feeds it into
    // the gate, because the server queues such a send instead of dispatching a
    // second session/prompt. So the gate is composed WITHOUT it now.
    expect(isQwenRunningTurn(RUNNING)).toBe(true);
    expect(shouldBlockComposerSend({ ...OPEN, hasSendableContent: true })).toBe(false);
  });

  it("compaction blocks the send on its own, with the running-turn signal already relaxed", () => {
    // Exactly the post-relax input shape: isRunningTurn no longer set by
    // isQwenRunningTurn, compaction still running. The block must survive.
    expect(
      shouldBlockComposerSend({
        ...OPEN,
        isCompactingContext: true,
        isRunningTurn: false,
        hasSendableContent: true,
      }),
    ).toBe(true);
  });

  it("compaction blocks the send while a qwen turn ALSO runs (the state the relax creates)", () => {
    // Before the wave this combination is unreachable in the UI, so nothing
    // pinned it. After the wave it is an ordinary state, and compaction is the
    // only thing still holding the composer.
    // Composed exactly as ChatView.onSend does AFTER the relax: the qwen
    // running-turn condition is no longer fed in at all, so compaction is the
    // only thing left holding the composer.
    const compactingMidTurn = {
      ...OPEN,
      isCompactingContext: true,
      hasSendableContent: true,
    };
    expect(shouldBlockComposerSend(compactingMidTurn)).toBe(true);
    // WAS (phase 1): dropping the compaction flag still blocked, via the
    // running-turn condition. Now nothing else is blocking — which is precisely
    // the owner ruling: the relax took the running-turn block and NOTHING else.
    expect(shouldBlockComposerSend({ ...compactingMidTurn, isCompactingContext: false })).toBe(
      false,
    );
  });

  it("the qwen-only scope of the running-turn block is itself part of the baseline", () => {
    // The relax must not widen the driver check either way: it is scoped to
    // qwen precisely because the other drivers already steer (sendGate.ts:58-62).
    expect(isQwenRunningTurn({ ...RUNNING, providerDriver: "claude" })).toBe(false);
    expect(isQwenRunningTurn(RUNNING)).toBe(true);
  });
});
