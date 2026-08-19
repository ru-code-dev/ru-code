// ru-code: extractQwenInputTokens reads qwen's running promptTokenCount off an
// agent_message_chunk's `update._meta.usage.inputTokens` and rejects everything
// else (notably totalTokens, which is a different aggregate). A regression here
// freezes or corrupts the mid-turn context meter, so the pure guard gets direct
// coverage of the happy path and every reject branch.
import { describe, expect, it } from "vite-plus/test";

import { extractQwenInputTokens } from "../../qwen/usage.ts";

// A well-formed raw SessionNotification params object carrying `inputTokens`.
const withUsage = (usage: unknown): unknown => ({
  sessionId: "s",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
    _meta: { usage },
  },
});

describe("extractQwenInputTokens", () => {
  it("reads inputTokens from update._meta.usage", () => {
    expect(extractQwenInputTokens(withUsage({ inputTokens: 1234 }))).toBe(1234);
    expect(extractQwenInputTokens(withUsage({ inputTokens: 0 }))).toBe(0);
  });

  it("ignores totalTokens (reads ONLY inputTokens)", () => {
    // Only totalTokens present ⇒ null (never falls back to totalTokens).
    expect(extractQwenInputTokens(withUsage({ totalTokens: 9999 }))).toBeNull();
    // Both present ⇒ inputTokens wins, totalTokens is never consulted.
    expect(extractQwenInputTokens(withUsage({ inputTokens: 500, totalTokens: 9999 }))).toBe(500);
  });

  it("returns null for a missing field at any level", () => {
    expect(extractQwenInputTokens(withUsage({}))).toBeNull(); // no inputTokens
    expect(extractQwenInputTokens({ sessionId: "s", update: { _meta: {} } })).toBeNull(); // no usage
    expect(extractQwenInputTokens({ sessionId: "s", update: {} })).toBeNull(); // no _meta
    expect(extractQwenInputTokens({ sessionId: "s" })).toBeNull(); // no update
  });

  it("returns null for negative, non-finite, or non-number values", () => {
    expect(extractQwenInputTokens(withUsage({ inputTokens: -1 }))).toBeNull();
    expect(extractQwenInputTokens(withUsage({ inputTokens: Number.NaN }))).toBeNull();
    expect(extractQwenInputTokens(withUsage({ inputTokens: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(extractQwenInputTokens(withUsage({ inputTokens: "1000" }))).toBeNull();
  });

  it("returns null when any level is not a plain object", () => {
    expect(extractQwenInputTokens(null)).toBeNull();
    expect(extractQwenInputTokens(undefined)).toBeNull();
    expect(extractQwenInputTokens("nope")).toBeNull();
    expect(extractQwenInputTokens([1, 2, 3])).toBeNull(); // array is not a record
    expect(extractQwenInputTokens({ sessionId: "s", update: [] })).toBeNull();
    expect(extractQwenInputTokens({ sessionId: "s", update: { _meta: { usage: 5 } } })).toBeNull();
  });
});
