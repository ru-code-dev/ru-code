// ru-code: the client half of the chatViewMode thread-state vertical — the
// `thread.chat-view-mode-set` reducer case and the `thread.created` seeding.
// Covers the marked seams in packages/client-runtime/src/state/threadReducer.ts.
import { describe, expect, it } from "vite-plus/test";

import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "../../state/threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-chat-view"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  chatViewMode: null,
  settledOverride: null,
  settledAt: null,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("threadReducer chatViewMode", () => {
  it("thread.chat-view-mode-set pins the choice and bumps updatedAt", () => {
    const result = applyThreadDetailEvent(baseThread, {
      ...baseEventFields,
      sequence: 2,
      occurredAt: "2026-04-01T02:00:00.000Z",
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-1"),
      type: "thread.chat-view-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        chatViewMode: "detailed",
        updatedAt: "2026-04-01T02:00:00.000Z",
      },
    });

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.chatViewMode).toBe("detailed");
      expect(result.thread.updatedAt).toBe("2026-04-01T02:00:00.000Z");
      // Untouched neighbors survive the spread.
      expect(result.thread.interactionMode).toBe("default");
      expect(result.thread.title).toBe("Test Thread");
    }
  });

  it("an explicit return to compact is a real value, not a fall-through to null", () => {
    const detailedThread: OrchestrationThread = { ...baseThread, chatViewMode: "detailed" };
    const result = applyThreadDetailEvent(detailedThread, {
      ...baseEventFields,
      sequence: 3,
      occurredAt: "2026-04-01T03:00:00.000Z",
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-1"),
      type: "thread.chat-view-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        chatViewMode: "compact",
        updatedAt: "2026-04-01T03:00:00.000Z",
      },
    });

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.chatViewMode).toBe("compact");
    }
  });

  it("thread.created seeds the thread with the payload's explicit choice", () => {
    const result = applyThreadDetailEvent(baseThread, {
      ...baseEventFields,
      sequence: 1,
      occurredAt: "2026-04-01T01:00:00.000Z",
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-2"),
      type: "thread.created",
      payload: {
        threadId: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-1"),
        title: "Born Detailed",
        modelSelection: { instanceId: ProviderInstanceId.make("qwen"), model: "m" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        chatViewMode: "detailed",
        branch: null,
        worktreePath: null,
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
    });

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.id).toBe("thread-2");
      expect(result.thread.chatViewMode).toBe("detailed");
    }
  });
});
