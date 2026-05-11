/**
 * Shared prompt builders for text generation providers.
 *
 * Extracts the prompt construction logic that is identical across
 * Codex, Claude, and any future CLI-based text generation backends.
 *
 * @module textGenerationPrompts
 */
import * as Schema from "effect/Schema";
import type { ChatAttachment } from "@t3tools/contracts";

import { limitSection } from "./TextGenerationUtils.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

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
    "You write concise git commit messages.",
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
    "You write GitHub pull request content.",
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

// ---------------------------------------------------------------------------
// Branch name
// ---------------------------------------------------------------------------

export const BranchNameOutputSchema = Schema.Struct({
  branch: Schema.String,
});

export interface BranchNamePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

interface PromptFromMessageInput {
  instruction: string;
  responseShape: string;
  rules: ReadonlyArray<string>;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  additionalInstructions?: string | undefined;
}

function buildPromptFromMessage(input: PromptFromMessageInput): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  const promptSections = [
    input.instruction,
    input.responseShape,
    "Rules:",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    "User message:",
    limitSection(input.message, 8_000),
    ...policyInstruction(input.additionalInstructions),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return promptSections.join("\n");
}

export function buildBranchNamePrompt(input: BranchNamePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You generate concise git branch names.",
    responseShape: "Return a JSON object with key: branch.",
    rules: [
      "Branch should describe the requested work from the user message.",
      "Keep it short and specific (2-6 words).",
      "Use plain words only, no issue prefixes and no punctuation-heavy text.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.branchInstructions,
  });

  return { prompt, outputSchema: BranchNameOutputSchema };
}

// ---------------------------------------------------------------------------
// Thread title
// ---------------------------------------------------------------------------

export const ThreadTitleOutputSchema = Schema.Struct({
  title: Schema.String,
});

export interface ThreadTitlePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  policy?: TextGenerationPolicy | undefined;
}

export function buildThreadTitlePrompt(input: ThreadTitlePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You write concise thread titles for coding conversations.",
    responseShape: "Return a JSON object with key: title.",
    rules: [
      "Title MUST be in Russian (Русский язык).",
      "Title should summarize the user's request, not restate it verbatim.",
      "Keep it short and specific (3-8 words).",
      "Avoid quotes, filler, prefixes, and trailing punctuation.",
      "Technical identifiers (file names, symbols, library names) MAY stay in English.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
    additionalInstructions: input.policy?.threadTitleInstructions,
  });

  return { prompt, outputSchema: ThreadTitleOutputSchema };
}
