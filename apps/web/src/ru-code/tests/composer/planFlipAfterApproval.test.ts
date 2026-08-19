// ru-code: the WHOLE plan→code flip gate ChatView applies after an approval
// response (success + held-plan requestId match + approving decision). The
// inner decision was tested alone while the wired gate had zero tests.
import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldFlipComposerToCodeAfterApprovalResponse } from "../../composer/planActions";

const PLAN_REQUEST = ApprovalRequestId.make("req-plan-1");
const OTHER_REQUEST = ApprovalRequestId.make("req-cmd-1");

describe("shouldFlipComposerToCodeAfterApprovalResponse", () => {
  it("successful approve of THE held plan approval flips", () => {
    for (const decision of ["accept", "acceptForSession"] as const) {
      expect(
        shouldFlipComposerToCodeAfterApprovalResponse({
          responseSucceeded: true,
          respondedRequestId: PLAN_REQUEST,
          planApprovalRequestId: PLAN_REQUEST,
          decision,
        }),
      ).toBe(true);
    }
  });

  it("failed RPC never flips, even for an approving decision", () => {
    expect(
      shouldFlipComposerToCodeAfterApprovalResponse({
        responseSucceeded: false,
        respondedRequestId: PLAN_REQUEST,
        planApprovalRequestId: PLAN_REQUEST,
        decision: "accept",
      }),
    ).toBe(false);
  });

  it("a different approval (command etc.) never flips", () => {
    expect(
      shouldFlipComposerToCodeAfterApprovalResponse({
        responseSucceeded: true,
        respondedRequestId: OTHER_REQUEST,
        planApprovalRequestId: PLAN_REQUEST,
        decision: "accept",
      }),
    ).toBe(false);
  });

  it("no held plan approval (null — every non-qwen provider) never flips", () => {
    expect(
      shouldFlipComposerToCodeAfterApprovalResponse({
        responseSucceeded: true,
        respondedRequestId: PLAN_REQUEST,
        planApprovalRequestId: null,
        decision: "accept",
      }),
    ).toBe(false);
  });

  it("decline/cancel never flip", () => {
    for (const decision of ["decline", "cancel"] as const) {
      expect(
        shouldFlipComposerToCodeAfterApprovalResponse({
          responseSucceeded: true,
          respondedRequestId: PLAN_REQUEST,
          planApprovalRequestId: PLAN_REQUEST,
          decision,
        }),
      ).toBe(false);
    }
  });
});
