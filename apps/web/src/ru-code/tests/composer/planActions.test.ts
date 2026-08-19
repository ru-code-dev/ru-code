import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  decisionFromRuntimeMode,
  deriveComposerModeControlsState,
  selectPlanPrimaryAction,
  shouldSwitchToCodeAfterApproval,
  skipPendingUserInput,
} from "../../composer/planActions";

const requestId = ApprovalRequestId.make("req-plan-1");

describe("selectPlanPrimaryAction (M2)", () => {
  it("approves in the same thread when a plan_approval Deferred is live", () => {
    expect(selectPlanPrimaryAction({ pendingPlanApprovalRequestId: requestId })).toEqual({
      label: "Implement",
      handlerKind: "same-thread",
    });
  });

  it("falls back to a new thread when no Deferred is live (non-qwen / stale)", () => {
    expect(selectPlanPrimaryAction({ pendingPlanApprovalRequestId: null })).toEqual({
      label: "Implement in a new thread",
      handlerKind: "new-thread",
    });
  });
});

describe("decisionFromRuntimeMode (M2)", () => {
  it("accepts for the whole session under full-access", () => {
    expect(decisionFromRuntimeMode("full-access")).toBe("acceptForSession");
  });

  it("accepts for the whole session under auto-accept-edits", () => {
    expect(decisionFromRuntimeMode("auto-accept-edits")).toBe("acceptForSession");
  });

  it("does a one-shot accept under approval-required", () => {
    expect(decisionFromRuntimeMode("approval-required")).toBe("accept");
  });
});

describe("deriveComposerModeControlsState (M5/M6)", () => {
  it("disables the mode controls while a turn streams (phase running)", () => {
    expect(deriveComposerModeControlsState({ phase: "running", allowsFullAccess: true })).toEqual({
      modeControlsDisabled: true,
      fullAccessDisabled: false,
    });
  });

  it("enables the mode controls when the session is ready", () => {
    expect(deriveComposerModeControlsState({ phase: "ready", allowsFullAccess: true })).toEqual({
      modeControlsDisabled: false,
      fullAccessDisabled: false,
    });
  });

  it("keeps the mode controls enabled during a non-running pause (approval/connect)", () => {
    // Gated on phase === "running" ONLY (not isWorking) so a connect/checkpoint
    // or approval pause leaves the controls live.
    expect(
      deriveComposerModeControlsState({ phase: "connecting", allowsFullAccess: true }),
    ).toMatchObject({ modeControlsDisabled: false });
    expect(
      deriveComposerModeControlsState({ phase: "disconnected", allowsFullAccess: true }),
    ).toMatchObject({ modeControlsDisabled: false });
  });

  it("locks the full-access option for providers that forbid it", () => {
    expect(
      deriveComposerModeControlsState({ phase: "ready", allowsFullAccess: false }),
    ).toMatchObject({ fullAccessDisabled: true });
  });
});

describe("shouldSwitchToCodeAfterApproval (M2b)", () => {
  it("switches plan → code when the live plan approval is accepted", () => {
    expect(
      shouldSwitchToCodeAfterApproval({ isPlanApprovalRequest: true, decision: "accept" }),
    ).toBe(true);
    expect(
      shouldSwitchToCodeAfterApproval({
        isPlanApprovalRequest: true,
        decision: "acceptForSession",
      }),
    ).toBe(true);
  });

  it("does NOT switch on decline/cancel of a plan approval", () => {
    expect(
      shouldSwitchToCodeAfterApproval({ isPlanApprovalRequest: true, decision: "decline" }),
    ).toBe(false);
    expect(
      shouldSwitchToCodeAfterApproval({ isPlanApprovalRequest: true, decision: "cancel" }),
    ).toBe(false);
  });

  it("does NOT switch for a non-plan approval (other providers / other kinds)", () => {
    expect(
      shouldSwitchToCodeAfterApproval({ isPlanApprovalRequest: false, decision: "accept" }),
    ).toBe(false);
    expect(
      shouldSwitchToCodeAfterApproval({
        isPlanApprovalRequest: false,
        decision: "acceptForSession",
      }),
    ).toBe(false);
  });
});

describe("skipPendingUserInput (M8)", () => {
  it("submits an empty answers payload for the parked request", () => {
    const respond = vi.fn();
    skipPendingUserInput({ requestId, respond });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(requestId, {});
  });

  it("is a no-op when nothing is parked", () => {
    const respond = vi.fn();
    skipPendingUserInput({ requestId: null, respond });
    expect(respond).not.toHaveBeenCalled();
  });
});
