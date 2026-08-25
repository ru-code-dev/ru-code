// ru-code: the instruction lines our text-generation calls send to the CLI. Kept here as
// a single source so the analytics category classifier can recognize these one-shot
// calls in qwen's transcripts — the consumer is @smart-tools/qwen-cli-analytics
// (core/serviceSignatures.ts), and the drift guard is
// apps/server/src/ru-code/tests/analytics/serviceSignaturesDrift.test.ts, which asserts
// every marker IS a substring of its instruction. Reword an instruction past its marker
// and that test fails instead of sessions silently misclassifying. A pure leaf module
// (plain strings, no deps) so importing it pulls nothing heavy.

export const THREAD_TITLE_INSTRUCTION =
  "You write concise titles for coding conversations. Reply in Russian (Русский язык). Technical identifiers (file names, symbols) may stay in English.";

export const BRANCH_NAME_INSTRUCTION = "You generate concise git branch name fragments.";

export const COMMIT_MESSAGE_INSTRUCTION = "You write concise git commit messages.";

export const PR_CONTENT_INSTRUCTION = "You write GitHub pull request content.";
