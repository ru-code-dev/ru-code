// ru-code: the chat-view choice is a private UI preference — it must never be
// published as agent awareness. Covers the marked `return false` case in
// apps/server/src/relay/AgentAwarenessRelay.ts.
import { describe, expect, it } from "vite-plus/test";

import { CommandId, EventId, ThreadId } from "@t3tools/contracts";

import { shouldPublishAgentAwarenessEvent } from "../../../relay/AgentAwarenessRelay.ts";

describe("shouldPublishAgentAwarenessEvent (chat view mode)", () => {
  it("thread.chat-view-mode-set is never published", () => {
    expect(
      shouldPublishAgentAwarenessEvent({
        sequence: 1,
        eventId: EventId.make("evt-chat-view-awareness"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.chat-view-mode-set",
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: CommandId.make("cmd-chat-view-awareness"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-chat-view-awareness"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          chatViewMode: "detailed",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
