// ru-code: chat view-mode resolution — composer override (staging) → the
// thread's pinned choice (authority, plan-mode parity) → server-settings
// default. The store side (setChatViewMode persistence + pruning) is covered
// in composerDraftStore.test.ts; the schema default in contracts settings.test.ts.
import { describe, expect, it } from "vite-plus/test";

import { resolveChatViewMode } from "../../extended-chat/chatViewMode";

describe("resolveChatViewMode", () => {
  it("falls back to the settings default when neither staging nor thread has a choice", () => {
    expect(resolveChatViewMode(null, null, "compact")).toBe("compact");
    expect(resolveChatViewMode(null, null, "detailed")).toBe("detailed");
  });

  it("the thread's pinned choice wins over the settings default", () => {
    expect(resolveChatViewMode(null, "detailed", "compact")).toBe("detailed");
    expect(resolveChatViewMode(null, "compact", "detailed")).toBe("compact");
  });

  it("the composer override (staging) wins over everything", () => {
    expect(resolveChatViewMode("detailed", "compact", "compact")).toBe("detailed");
    expect(resolveChatViewMode("compact", "detailed", "detailed")).toBe("compact");
  });
});
