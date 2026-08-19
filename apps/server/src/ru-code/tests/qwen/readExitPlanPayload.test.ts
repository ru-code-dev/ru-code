// ru-code: the plan-markdown parse from a held session/request_permission. Only a
// non-empty string `toolCall.rawInput.plan` triggers the exit_plan_mode held-approval
// branch; a regression returning undefined on a valid plan silently breaks plan mode.
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import { readExitPlanPayload } from "../../qwen/QwenAdapter.ts";

const req = (rawInput: unknown): EffectAcpSchema.RequestPermissionRequest =>
  ({ sessionId: "s", options: [], toolCall: { toolCallId: "t", rawInput } }) as never;

describe("readExitPlanPayload", () => {
  it("returns the trimmed plan markdown when present", () => {
    expect(readExitPlanPayload(req({ plan: "  # Plan\n1. x  " }))).toEqual({
      plan: "# Plan\n1. x",
    });
  });

  it("returns undefined for missing / empty / non-string plan", () => {
    expect(readExitPlanPayload(req({ plan: "   " }))).toBeUndefined();
    expect(readExitPlanPayload(req({ plan: 42 }))).toBeUndefined();
    expect(readExitPlanPayload(req({}))).toBeUndefined();
    expect(readExitPlanPayload(req(null))).toBeUndefined();
  });
});
