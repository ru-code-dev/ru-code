// ru-code: coverage for the leaf instruction constants. These strings are the
// single source shared with the Stats transcript parser (serviceSignatures.ts),
// so their exact presence/shape is load-bearing: the thread-title instruction
// must steer the model to Russian, and the four constants must stay distinct.
import { describe, expect, it } from "vite-plus/test";

import {
  BRANCH_NAME_INSTRUCTION,
  COMMIT_MESSAGE_INSTRUCTION,
  PR_CONTENT_INSTRUCTION,
  THREAD_TITLE_INSTRUCTION,
} from "@ru-code/qwen/textgen/instructions";

describe("text generation instruction constants", () => {
  it("thread-title instruction steers the model to Russian", () => {
    expect(THREAD_TITLE_INSTRUCTION).toContain("Russian");
    expect(THREAD_TITLE_INSTRUCTION).toContain("Русский язык");
  });

  it("all four constants are non-empty", () => {
    for (const value of [
      THREAD_TITLE_INSTRUCTION,
      BRANCH_NAME_INSTRUCTION,
      COMMIT_MESSAGE_INSTRUCTION,
      PR_CONTENT_INSTRUCTION,
    ]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("each constant is distinct", () => {
    const values = [
      THREAD_TITLE_INSTRUCTION,
      BRANCH_NAME_INSTRUCTION,
      COMMIT_MESSAGE_INSTRUCTION,
      PR_CONTENT_INSTRUCTION,
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps the exact single-source branch and commit wording", () => {
    expect(BRANCH_NAME_INSTRUCTION).toBe("You generate concise git branch name fragments.");
    expect(COMMIT_MESSAGE_INSTRUCTION).toBe("You write concise git commit messages.");
    expect(PR_CONTENT_INSTRUCTION).toBe("You write GitHub pull request content.");
  });
});
