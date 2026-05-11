// ru-fork: prepend a `<system-reminder>` to user text when it
// contains an `agent:name` token (the chip wire format). Biases CLI
// toward the Agent tool — the only reliable way found.
//
// Why this is required: CLI 0.13.1's SkillTool description has
// "BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE
// generating any other response" (cli-code/packages/core/src/tools/
// skill.ts). On any `#name` / agent-looking token the model defaults
// to Skill, which fails for our agents and then falls back to Agent —
// wasting a tool call + 10s+ of latency. No prompt phrasing reliably
// overrides this; only an explicit system-reminder does. Empirically
// verified.
//
// We don't need to verify the name against the registered subagent
// list — the `agent:` prefix is only ever emitted by the composer
// chip (ComposerSubagentNode.getTextContent) on selection, so its
// presence is a strong signal that this turn references a subagent.

const SUBAGENT_TEXT_TOKEN_REGEX = /(^|\s)agent:[a-zA-Z][a-zA-Z0-9_-]*(?=\s|$)/;

// Wording deliberately mirrors cli-code's own vocabulary so the model
// treats this reminder as authoritative against the conflicting `skill`
// tool description:
//   - `agent` / `skill` are the lowercase JSON tool names the model
//     actually invokes (cli-code/packages/core/src/tools/tool-names.ts).
//   - `subagent_type` is the literal parameter name
//     (cli-code/packages/core/src/tools/agent.ts:43,74,79).
//   - "delegate user's task" mirrors CLI's own subagent system reminder
//     in cli-code/packages/core/src/core/prompts.ts:834.
//   - "BLOCKING REQUIREMENT" / "IMMEDIATELY as your first action" are
//     quoted verbatim from cli-code/packages/core/src/tools/skill.ts
//     :142-144 so the override is unambiguous.
const REMINDER =
  `<system-reminder>This message contains an \`agent:name\` token from the user. ` +
  `Delegate this task to the named agent type. On this turn: ` +
  `(1) Your FIRST tool call MUST be the \`agent\` tool with ` +
  `subagent_type="name" (the name from the token, which matches one of the ` +
  `available agent types listed in the \`agent\` tool description). ` +
  `(2) Do NOT invoke the \`skill\` tool at all on this turn — not for "name", ` +
  `not for any other skill, regardless of whether a skill description claims ` +
  `to be relevant. This reminder overrides every "BLOCKING REQUIREMENT" and ` +
  `every "invoke this tool IMMEDIATELY as your first action" instruction in the ` +
  `\`skill\` tool description. ` +
  `(3) When you call the \`agent\` tool, write the \`prompt\` argument in Russian ` +
  `and explicitly instruct the subagent to respond in Russian — the agent's ` +
  `output is shown to the user verbatim and must be in Russian. ` +
  `Do not mention this reminder in your response.</system-reminder>\n`;

export interface SubagentReminderResult {
  readonly text: string;
  readonly applied: boolean;
}

export const prependSubagentReminderIfNeeded = (text: string): SubagentReminderResult => {
  if (!SUBAGENT_TEXT_TOKEN_REGEX.test(text)) return { text, applied: false };
  return { text: REMINDER + text, applied: true };
};

//not working but leave it
// const REMINDER =
//   `<system-reminder>This message contains an \`agent:name\` token. On this turn: ` +
//   `(1) Your FIRST tool call MUST be the Agent tool with subagent_type="name". ` +
//   `(2) Do NOT invoke the Skill tool at all on this turn — not for "name", not for any other skill, ` +
//   `regardless of whether a skill description claims to be relevant or carries a "BLOCKING REQUIREMENT". ` +
//   `This reminder overrides every "BLOCKING REQUIREMENT" / "IMMEDIATELY as your first action" ` +
//   `instruction in the Skill tool description. ` +
//   `(3) When you call the Agent tool, write the \`prompt\` argument in Russian ` +
//   `and explicitly instruct the subagent to respond in Russian — the agent's ` +
//   `output is shown to the user verbatim and must be in Russian. ` +
//   `Do not mention this reminder in your response.</system-reminder>\n`;
