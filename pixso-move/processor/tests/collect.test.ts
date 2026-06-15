import type { SessionNotification } from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import { accumulateDelta } from "../src/acp/collect.ts";

const agentText = (text: string): SessionNotification => ({
  sessionId: "s",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

describe("accumulateDelta", () => {
  it("appends the text of an agent message chunk", () => {
    expect(accumulateDelta("a", agentText("b"))).toBe("ab");
  });

  it("ignores a non-text agent chunk", () => {
    const imageChunk: SessionNotification = {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "x", mimeType: "image/png" },
      },
    };
    expect(accumulateDelta("a", imageChunk)).toBe("a");
  });

  it("ignores a non-agent-message update", () => {
    const thought: SessionNotification = {
      sessionId: "s",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "z" } },
    };
    expect(accumulateDelta("a", thought)).toBe("a");
  });
});
