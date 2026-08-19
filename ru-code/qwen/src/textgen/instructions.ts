// ru-code: the instruction lines our text-generation calls send to the CLI. Kept here
// as a single source so the Stats feature can recognize these one-shot calls in qwen's
// transcripts (apps/server/src/ru-code/stats/serviceSignatures.ts) without the two
// places drifting. A pure leaf module (plain strings, no deps) so importing it from the
// pure stats parser pulls nothing heavy.

export const THREAD_TITLE_INSTRUCTION =
  "You write concise titles for coding conversations. Reply in Russian (Русский язык). Technical identifiers (file names, symbols) may stay in English.";

export const BRANCH_NAME_INSTRUCTION = "You generate concise git branch name fragments.";

export const COMMIT_MESSAGE_INSTRUCTION = "You write concise git commit messages.";

export const PR_CONTENT_INSTRUCTION = "You write GitHub pull request content.";
