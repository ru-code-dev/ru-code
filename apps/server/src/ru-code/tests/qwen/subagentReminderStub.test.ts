// ru-code: coverage for the no-op subagent-reminder stub. Until the real
// subagents feature lands the adapter relies on this being a pass-through that
// never mutates the user text and always reports `applied: false`.
import { describe, expect, it } from "vite-plus/test";

import { prependSubagentReminderIfNeeded } from "@ru-code/qwen/subagentReminderStub";

describe("prependSubagentReminderIfNeeded (stub)", () => {
  it("returns the text unchanged and applied: false", () => {
    const result = prependSubagentReminderIfNeeded("hello world");
    expect(result.text).toBe("hello world");
    expect(result.applied).toBe(false);
  });

  it("does NOT react to an agent: mention (stub has no picker yet)", () => {
    const result = prependSubagentReminderIfNeeded("agent:refactorer please help");
    expect(result.text).toBe("agent:refactorer please help");
    expect(result.applied).toBe(false);
  });

  it("passes an empty string straight through", () => {
    const result = prependSubagentReminderIfNeeded("");
    expect(result.text).toBe("");
    expect(result.applied).toBe(false);
  });
});
