// ru-fork: hand-maintained whitelist of leading slash-command slugs the
// composer permits at submit. Unknown slugs are stripped (or, when bare,
// silently drop the submission) — see stripUnknownLeadingSlashCommand.
// Reason: cli-code (Session.ts:1057-1061) throws on any /command outside its
// ACP allowlist, surfacing as a JSON-RPC -32603 "Internal error" in ru-fork.
// Keep slugs lowercase; matching is case-insensitive.
export const KNOWN_SLASH_COMMAND_SLUGS: ReadonlySet<string> = new Set([
  "init",
  "summary",
  "compress",
  "review",
  "model",
  "plan",
  "default",
  "refresh-skills",
  "refresh-subagents",
]);
