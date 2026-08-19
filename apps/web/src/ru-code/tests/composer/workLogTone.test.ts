import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../../../session-logic";
import { workToneClass, workToneIcon } from "../../workLog/workToneVisuals";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.completed",
    summary: overrides.summary ?? "Activity",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
  };
}

describe("deriveWorkLogEntries — respond-failed rows get amber warning tone", () => {
  it("re-tones provider.approval.respond.failed from error to warning", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "approval-respond-failed",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: { requestId: "req-1", detail: "boom" },
      }),
    ]);
    expect(entries[0]?.tone).toBe("warning");
  });

  it("re-tones provider.user-input.respond.failed from error to warning", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "user-input-respond-failed",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: { requestId: "req-2", detail: "boom" },
      }),
    ]);
    expect(entries[0]?.tone).toBe("warning");
  });

  it("re-tones respond-failed rows for every provider (codex too)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "codex-approval-respond-failed",
        kind: "provider.approval.respond.failed",
        summary: "Provider adapter request failed (codex) for item/approval",
        tone: "error",
        payload: { requestId: "req-codex", detail: "codex respond failed" },
      }),
    ]);
    expect(entries[0]?.tone).toBe("warning");
  });

  it("keeps hard-error rows red (task.completed failed / runtime.error)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "task-failed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
      makeActivity({
        id: "runtime-error",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.error",
        summary: "Runtime error",
        tone: "error",
      }),
    ]);
    expect(entries.map((entry) => entry.tone)).toEqual(["error", "error"]);
  });
});

describe("workToneVisuals", () => {
  it("maps the warning tone to the amber triangle icon and amber class", () => {
    expect(workToneIcon("warning")).toEqual({
      iconName: "triangle-alert",
      className: "text-amber-600 dark:text-amber-300/90",
    });
    expect(workToneClass("warning")).toBe("text-amber-600 dark:text-amber-300/90");
  });

  it("keeps the error tone red (rose), distinct from warning", () => {
    expect(workToneIcon("error").iconName).toBe("circle-alert");
    expect(workToneClass("error")).toBe("text-rose-300/50 dark:text-rose-300/50");
  });
});
