// ru-code (B2): proves ACP failure work-log details are localized (English in EN-locale),
// matching the working skills-agents app. The server emits provider.{user-input,approval}.respond.failed
// with English payload.detail (ProviderCommandReactor stale-pending / no-session); the port
// previously showed those verbatim (only re-toned amber). localizeAcpFailureDetail maps the
// known shapes to the localized copy and returns null otherwise (caller falls back to raw text).
import { assert, describe, it } from "@effect/vitest";
import { CLI_DISPLAY_NAME } from "@ru-code/branding";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { localizeAcpFailureDetail } from "../../error-system/acpFailureLocalization.ts";

const activity = (kind: string, detail?: string): OrchestrationThreadActivity =>
  ({
    id: "act-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind,
    summary: "Provider response failed",
    ...(detail !== undefined ? { payload: { detail } } : {}),
    // minimal shape for the pure fn
  }) as any;

describe("localizeAcpFailureDetail", () => {
  it("localizes stale pending user-input", () => {
    assert.strictEqual(
      localizeAcpFailureDetail(
        activity("provider.user-input.respond.failed", "Stale pending user-input request: abc"),
      ),
      "The session expired — retry the request",
    );
  });

  it("localizes stale pending approval/permission", () => {
    assert.strictEqual(
      localizeAcpFailureDetail(
        activity("provider.approval.respond.failed", "Stale pending approval request: xyz"),
      ),
      "The session expired — retry the request",
    );
    assert.strictEqual(
      localizeAcpFailureDetail(
        activity("provider.approval.respond.failed", "Stale pending permission request: xyz"),
      ),
      "The session expired — retry the request",
    );
  });

  it("localizes no-active-session with the neutral CLI name", () => {
    assert.strictEqual(
      localizeAcpFailureDetail(
        activity("provider.user-input.respond.failed", "No active provider session for thread"),
      ),
      `The ${CLI_DISPLAY_NAME} session isn't active — retry the request`,
    );
  });

  it("returns null for non-failure activity kinds", () => {
    assert.isNull(
      localizeAcpFailureDetail(activity("task.completed", "Stale pending user-input request: x")),
    );
  });

  it("returns null for an unknown failure detail (caller falls back to raw text)", () => {
    assert.isNull(
      localizeAcpFailureDetail(activity("provider.approval.respond.failed", "Some other error")),
    );
  });
});
