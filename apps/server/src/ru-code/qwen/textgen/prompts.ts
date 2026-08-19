/**
 * Prompt builders for qwen's text generation.
 *
 * Owns the structured-output (JSON) prompt builders and their schemas that
 * qwen's `CliTextGeneration` port depends on. The port's shared
 * `textGeneration/TextGenerationPrompts.ts` has diverged and no longer exports
 * the `*OutputSchema` values, so qwen keeps its own copy here (ported verbatim
 * from the ru-code source).
 *
 * @module qwenTextGenerationPrompts
 */
import * as Schema from "effect/Schema";

import {
  COMMIT_MESSAGE_INSTRUCTION,
  PR_CONTENT_INSTRUCTION,
} from "@ru-code/qwen/textgen/instructions";
import { limitSection } from "../../../textGeneration/TextGenerationUtils.ts";
import type { TextGenerationPolicy } from "../../../textGeneration/TextGenerationPolicy.ts";

function policyInstruction(instruction: string | undefined): ReadonlyArray<string> {
  const trimmed = instruction?.trim();
  return trimmed ? ["", "Additional instructions:", limitSection(trimmed, 4_000)] : [];
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

export const CommitMessageOutputSchema = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
});

export const CommitMessageWithBranchOutputSchema = Schema.Struct({
  subject: Schema.String,
  body: Schema.String,
  branch: Schema.String,
});

export interface CommitMessagePromptInput {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch: boolean;
  policy?: TextGenerationPolicy | undefined;
}

export function buildCommitMessagePrompt(input: CommitMessagePromptInput) {
  const wantsBranch = input.includeBranch;

  const prompt = [
    COMMIT_MESSAGE_INSTRUCTION,
    wantsBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject MUST be in Russian (Русский язык), <= 72 chars, no trailing period",
    "- subject MUST start with a Conventional Commits prefix (feat:, fix:, refactor:, chore:, docs:, test:, style:, perf:, build:, ci:) followed by the Russian description; pick the prefix that best matches the change type",
    "- subject MAY keep technical identifiers in English (file names, function/symbol names, command names, library names)",
    "- subject describes the change in neutral Russian (e.g. «добавлены …», «исправлен баг в …»); do not invent an English imperative",
    "- body MUST be in Russian (Русский язык), short bullet points or empty string",
    "- body bullets describe what changed and why, in Russian; technical identifiers stay in English",
    ...(wantsBranch
      ? [
          "- branch must be a short semantic git branch fragment for this change (English, kebab-case)",
        ]
      : []),
    "- capture the primary user-visible or developer-visible change",
    ...policyInstruction(input.policy?.commitInstructions),
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");

  if (wantsBranch) {
    return { prompt, outputSchema: CommitMessageWithBranchOutputSchema };
  }

  return { prompt, outputSchema: CommitMessageOutputSchema };
}

// ---------------------------------------------------------------------------
// PR content
// ---------------------------------------------------------------------------

export const PrContentOutputSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});

export interface PrContentPromptInput {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  policy?: TextGenerationPolicy | undefined;
}

export function buildPrContentPrompt(input: PrContentPromptInput) {
  const prompt = [
    PR_CONTENT_INSTRUCTION,
    "Return a JSON object with keys: title, body.",
    "Rules:",
    "- title MUST be in Russian (Русский язык), concise and specific, no trailing punctuation",
    "- title MAY keep technical identifiers in English (file names, symbols, command names)",
    "- body MUST be markdown and include EXACTLY these English headings: '## Summary' and '## Testing'",
    "- bullet points and prose under those headings MUST be in Russian",
    "- under Summary: short Russian bullet points describing the change",
    "- under Testing: Russian bullet points with concrete checks, or 'Не запускалось' where appropriate",
    ...policyInstruction(input.policy?.changeRequestInstructions),
    "",
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    "Commits:",
    limitSection(input.commitSummary, 12_000),
    "",
    "Diff stat:",
    limitSection(input.diffSummary, 12_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");

  return { prompt, outputSchema: PrContentOutputSchema };
}
