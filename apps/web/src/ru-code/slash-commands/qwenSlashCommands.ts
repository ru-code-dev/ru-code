/**
 * ru-code: preconfigured slash commands for qwen-kind threads — the composer's
 * `/` picker offers them ONLY when the selected provider kind is the CLI kind
 * (any profile: stock qwen or a custom fork). RU descriptions are owned here so
 * nothing depends on qwen's `available_commands_update` notification.
 *
 * The list maps 1:1 to what qwen 0.13.1 actually serves over ACP:
 * built-ins `init`, `summary`, `compress` (nonInteractiveCliCommands.ts
 * ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE) + the bundled `review` SKILL
 * (skills/bundled/review; SKILL commands are always allowed in ACP mode).
 * `btw`/`bug` are allowed by qwen but deliberately not offered (feedback
 * commands, useless inside the app).
 *
 * Any OTHER leading `/command` typed by hand must never reach qwen: its ACP
 * slash path throws `Slash command not supported…` → a raw JSON-RPC -32603
 * (qwen Session.ts:1057-1061). `stripUnknownLeadingSlashCommand` enforces that
 * at submit (see its doc).
 *
 * @module ru-code/slash-commands/qwenSlashCommands
 */
import { QWEN_KIND } from "@ru-code/branding";
import type { ProviderDriverKind, ServerProviderSlashCommand } from "@t3tools/contracts";

/** Composer picker item shape (the existing `provider-slash-command` variant). */
export interface QwenSlashCommandComposerItem {
  id: string;
  type: "provider-slash-command";
  provider: ProviderDriverKind;
  command: ServerProviderSlashCommand;
  label: string;
  description: string;
  /** Grayed + unselectable in the picker (e.g. /compress in a draft). */
  disabled?: boolean;
}

export const QWEN_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "init", description: "Analyze the project and create a CLI context file" },
  { name: "summary", description: "Generate a project summary and save it to PROJECT_SUMMARY.md" },
  { name: "compress", description: "Compact the conversation history to save context" },
  { name: "review", description: "Review the changes; you can pass a PR number or a file path" },
];

/**
 * THE picker decision: the preconfigured commands for the selected provider
 * kind. Non-CLI kinds get [] — other providers keep their own (snapshot-
 * advertised) commands untouched. In a DRAFT (no thread exists yet) `/compress`
 * is offered disabled: it compacts an existing conversation, and dispatching
 * `thread.context.compact` without a thread dies at the engine invariant.
 */
export function buildQwenSlashCommandItems(
  selectedProvider: ProviderDriverKind,
  options?: { readonly isDraftThread?: boolean },
): ReadonlyArray<QwenSlashCommandComposerItem> {
  if (selectedProvider !== QWEN_KIND) return [];
  return QWEN_SLASH_COMMANDS.map((command) => ({
    id: `qwen-slash:${command.name}`,
    type: "provider-slash-command",
    provider: selectedProvider,
    command: { name: command.name, description: command.description },
    label: `/${command.name}`,
    description: command.description,
    ...(command.name === "compress" && options?.isDraftThread === true ? { disabled: true } : {}),
  }));
}

/**
 * Leading slash-command slugs the composer lets through to a qwen-kind thread:
 * the preconfigured commands above + qwen's remaining ACP-allowed built-ins
 * (`btw`, `bug` — allowed, just not advertised in the picker) + the app's own
 * composer commands (`model`, `plan`, `default` — consumed client-side before
 * send, listed so a leftover literal never gets stripped as "unknown").
 * Lowercase; matching is case-insensitive.
 */
export const KNOWN_QWEN_SLASH_COMMAND_SLUGS: ReadonlySet<string> = new Set([
  ...QWEN_SLASH_COMMANDS.map((command) => command.name),
  "btw",
  "bug",
  "model",
  "plan",
  "default",
]);

const LEADING_SLASH_COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Submit-time guard for qwen-kind threads. Three outcomes:
 *   - no leading `/command`, or a known slug → the input passes verbatim;
 *   - unknown slug with trailing text → the `/slug` is stripped, the rest is sent;
 *   - bare unknown slug → `null`: the caller must ABORT the submit (qwen would
 *     answer the raw command with a -32603 protocol error).
 *
 * Trims first so leading whitespace can't smuggle a command past the check.
 */
export function stripUnknownLeadingSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = LEADING_SLASH_COMMAND.exec(trimmed);
  if (!match?.[1]) return text;
  const slug = match[1].toLowerCase();
  if (KNOWN_QWEN_SLASH_COMMAND_SLUGS.has(slug)) return text;
  const trailingText = match[2]?.trim() ?? "";
  return trailingText === "" ? null : trailingText;
}

export type QwenSubmitPromptDecision =
  | { readonly action: "send"; readonly prompt: string }
  | { readonly action: "abort" }
  | { readonly action: "compact" };

/** A bare `/compress` (nothing else, case-insensitive) — see resolveQwenSubmitPrompt. */
function isBareCompressCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compress";
}

/**
 * The WHOLE submit decision ChatView.onSend applies for the qwen kind, as one
 * testable composite: non-qwen kinds pass verbatim; a BARE `/compress` routes
 * to the hidden compaction flow (`compactContext` — the same path as the
 * context-meter button: one timeline row, no user bubble, no regular turn);
 * other qwen prompts go through `stripUnknownLeadingSlashCommand`; a bare
 * unknown `/slug` aborts the submit UNLESS non-text content (images/contexts/
 * annotations) still makes the send meaningful — then the slug is dropped and
 * the attachments go alone. `/compress` WITH attachments or trailing text
 * keeps the regular send path (qwen runs its visible compress turn).
 */
export function resolveQwenSubmitPrompt(input: {
  readonly selectedProvider: ProviderDriverKind;
  readonly prompt: string;
  readonly hasNonTextContent: boolean;
}): QwenSubmitPromptDecision {
  if (input.selectedProvider !== QWEN_KIND) {
    return { action: "send", prompt: input.prompt };
  }
  if (!input.hasNonTextContent && isBareCompressCommand(input.prompt)) {
    return { action: "compact" };
  }
  const strippedPrompt = stripUnknownLeadingSlashCommand(input.prompt);
  if (strippedPrompt === null) {
    return input.hasNonTextContent ? { action: "send", prompt: "" } : { action: "abort" };
  }
  return { action: "send", prompt: strippedPrompt };
}
