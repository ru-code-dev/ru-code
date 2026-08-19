// ru-code: coverage for qwen's own prompt builders + structured-output schemas.
// Asserts schema decode/encode round-trips, the branch/no-branch prompt shape
// switch, policy-instruction injection, section truncation, and that the right
// outputSchema object is returned alongside each prompt.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  CommitMessageOutputSchema,
  CommitMessageWithBranchOutputSchema,
  PrContentOutputSchema,
} from "../../../qwen/textgen/prompts.ts";
import {
  COMMIT_MESSAGE_INSTRUCTION,
  PR_CONTENT_INSTRUCTION,
} from "@ru-code/qwen/textgen/instructions";

const decodeCommitMessage = Schema.decodeSync(CommitMessageOutputSchema);
const encodeCommitMessage = Schema.encodeSync(CommitMessageOutputSchema);
const decodeUnknownCommitMessage = Schema.decodeUnknownSync(CommitMessageOutputSchema);
const decodeCommitMessageWithBranch = Schema.decodeSync(CommitMessageWithBranchOutputSchema);
const decodeUnknownCommitMessageWithBranch = Schema.decodeUnknownSync(
  CommitMessageWithBranchOutputSchema,
);
const decodePrContent = Schema.decodeSync(PrContentOutputSchema);

describe("output schemas", () => {
  it("CommitMessageOutputSchema round-trips subject/body", () => {
    const value = { subject: "feat: x", body: "- y" };
    expect(decodeCommitMessage(value)).toEqual(value);
    expect(encodeCommitMessage(value)).toEqual(value);
  });

  it("CommitMessageOutputSchema rejects a missing field", () => {
    expect(() => decodeUnknownCommitMessage({ subject: "x" })).toThrow();
  });

  it("CommitMessageWithBranchOutputSchema requires the branch field", () => {
    const value = { subject: "feat: x", body: "- y", branch: "feature/z" };
    expect(decodeCommitMessageWithBranch(value)).toEqual(value);
    expect(() => decodeUnknownCommitMessageWithBranch({ subject: "x", body: "y" })).toThrow();
  });

  it("PrContentOutputSchema round-trips title/body", () => {
    const value = { title: "T", body: "B" };
    expect(decodePrContent(value)).toEqual(value);
  });
});

describe("buildCommitMessagePrompt", () => {
  it("no-branch variant: subject/body keys, no branch rule, matching schema", () => {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "diff body",
      includeBranch: false,
    });
    expect(prompt).toContain(COMMIT_MESSAGE_INSTRUCTION);
    expect(prompt).toContain("Return a JSON object with keys: subject, body.");
    expect(prompt).not.toContain("subject, body, branch");
    expect(prompt).not.toContain("semantic git branch fragment");
    // null branch is rendered as the detached placeholder
    expect(prompt).toContain("Branch: (detached)");
    expect(prompt).toContain("M a.ts");
    expect(outputSchema).toBe(CommitMessageOutputSchema);
  });

  it("branch variant: adds branch key + rule, echoes branch name, matching schema", () => {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "s",
      stagedPatch: "p",
      includeBranch: true,
    });
    expect(prompt).toContain("Return a JSON object with keys: subject, body, branch.");
    expect(prompt).toContain("semantic git branch fragment");
    expect(prompt).toContain("Branch: main");
    expect(outputSchema).toBe(CommitMessageWithBranchOutputSchema);
  });

  it("injects policy commit instructions when provided", () => {
    const { prompt } = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "s",
      stagedPatch: "p",
      includeBranch: false,
      policy: {
        kind: "custom",
        inferRepositoryConventions: false,
        commitInstructions: "Всегда упоминай тикет JIRA",
      },
    });
    expect(prompt).toContain("Additional instructions:");
    expect(prompt).toContain("Всегда упоминай тикет JIRA");
  });

  it("truncates an oversized staged patch with a marker", () => {
    const huge = "x".repeat(50_000);
    const { prompt } = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "s",
      stagedPatch: huge,
      includeBranch: false,
    });
    expect(prompt).toContain("[truncated]");
  });
});

describe("buildPrContentPrompt", () => {
  it("emits title/body keys, English headings, branches, and its schema", () => {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/x",
      commitSummary: "c",
      diffSummary: "d",
      diffPatch: "p",
    });
    expect(prompt).toContain(PR_CONTENT_INSTRUCTION);
    expect(prompt).toContain("Return a JSON object with keys: title, body.");
    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Testing");
    expect(prompt).toContain("Base branch: main");
    expect(prompt).toContain("Head branch: feature/x");
    expect(outputSchema).toBe(PrContentOutputSchema);
  });

  it("injects policy change-request instructions when provided", () => {
    const { prompt } = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/x",
      commitSummary: "c",
      diffSummary: "d",
      diffPatch: "p",
      policy: {
        kind: "custom",
        inferRepositoryConventions: false,
        changeRequestInstructions: "Ссылайся на дизайн-док",
      },
    });
    expect(prompt).toContain("Additional instructions:");
    expect(prompt).toContain("Ссылайся на дизайн-док");
  });
});
