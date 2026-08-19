// ru-code: no-op stub. The real subagent-reminder belongs to the separate
// subagents feature; the qwen adapter works without it. Wire the real one
// (ru-code/subagents/userTextSubagentReminder) when that feature lands.
export interface SubagentReminderResult {
  readonly text: string;
  readonly applied: boolean;
}
export const prependSubagentReminderIfNeeded = (text: string): SubagentReminderResult => ({
  text,
  applied: false,
});
