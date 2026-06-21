// ru-fork: our own one-shot text-generation calls (CliTextGeneration /
// TextGenerationPrompts) reach qwen as bare-hash sessions, indistinguishable from a
// real `qwen -p` except by the instruction we sent. We match the session's first user
// message against those instructions to categorize it.
//
// `instruction` is imported from the SINGLE source (textGeneration/instructions.ts), so
// it can't drift. `marker` is a distinctive substring of it — matched against the
// transcript (more robust than the full string to historical wording variants). The
// drift guard in serviceSignatures.test.ts asserts every marker IS a substring of its
// instruction, so rewording a prompt past its marker fails a test instead of silently
// misclassifying.
import type { StatsCategory } from "@t3tools/contracts";

import {
  BRANCH_NAME_INSTRUCTION,
  COMMIT_MESSAGE_INSTRUCTION,
  PR_CONTENT_INSTRUCTION,
  THREAD_TITLE_INSTRUCTION,
} from "../../textGeneration/instructions.ts";

export interface ServiceSignature {
  readonly category: StatsCategory;
  /** The full instruction our server sends (single source of truth). */
  readonly instruction: string;
  /** Distinctive substring of `instruction`, matched against the transcript content. */
  readonly marker: string;
}

export const SERVICE_SIGNATURES: readonly ServiceSignature[] = [
  { category: "title", instruction: THREAD_TITLE_INSTRUCTION, marker: "titles for coding conversations" },
  { category: "branch", instruction: BRANCH_NAME_INSTRUCTION, marker: "concise git branch name" },
  { category: "commit", instruction: COMMIT_MESSAGE_INSTRUCTION, marker: "git commit messages" },
  { category: "pr", instruction: PR_CONTENT_INSTRUCTION, marker: "pull request content" },
];
