// ru-fork: scanner for `agent:name` tokens in composer text.
// Lives here (ru-fork-only) instead of inside composer-editor-mentions.ts
// so the upstream-shared file's diff stays a one-line import + push.
//
// Wire format is `agent:name` (not `#name`) so the server-side
// CliAdapter can detect it without a name lookup and inject the
// subagent system-reminder. See userTextSubagentReminder.ts on the
// server side.

// `agent:name` parallel to SKILL_TOKEN_REGEX. Letter-start + trailing
// whitespace lookahead so a partial type prefix (e.g. `agent:foo:bar` —
// no, we DO want to chip-ify; agent names are alphanumeric/_-/ only)
// doesn't accidentally chip.
export const SUBAGENT_TOKEN_REGEX = /(^|\s)agent:([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|$)/g;

export interface SubagentTokenMatch {
  type: "subagent";
  value: string;
  start: number;
  end: number;
}

export const collectSubagentTokenMatches = (text: string): SubagentTokenMatch[] => {
  const matches: SubagentTokenMatch[] = [];
  for (const match of text.matchAll(SUBAGENT_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const agentName = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    if (agentName.length > 0) {
      matches.push({ type: "subagent", value: agentName, start, end });
    }
  }
  return matches;
};
