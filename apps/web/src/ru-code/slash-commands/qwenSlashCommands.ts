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
 * EXCEPTION — catalog custom commands: qwen ALSO runs the user's own commands
 * deployed under `<cwd>/.qwen/commands/`. Those are dynamic (the Commands panel
 * adds/removes/connects them per project), so the guard cannot list them here.
 * The caller passes the LIVE effective set into the guard as `catalogCommandSlugs`;
 * since A25 it comes from the catalogs PLUGIN's `command` composer provider, via
 * `usePluginCommandSlugs`, so the allowlist recalculates whenever the command list
 * changes — and is empty (every `/command` unknown) when no such plugin is installed.
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

/** The leading `/command` of a line: its lower-cased slug, and whatever the user typed after it. */
export interface LeadingSlashCommand {
  /** Lower-cased, because every allowlist this is matched against is lowercase. */
  readonly slug: string;
  /** The rest of the line, trimmed; `""` when the command was bare. */
  readonly rest: string;
}

/**
 * THE reader of a leading `/command`, and the only one.
 *
 * A NAME IS ANYTHING WITHOUT WHITESPACE — qwen's own rule, not a charset of ours: it derives a
 * command's name from its file path (`command-factory.ts`) and splits the typed line on
 * `/\s+/u` (`slashCommandProcessor.ts`), so `/сборка`, `/deploy.prod` and `/fs:ls` are all names
 * it runs. Trims first, so leading whitespace cannot smuggle a command past the check.
 *
 * It is exported because the composer's plugin allowlist (`plugins/composerRows.ts`
 * `pluginCommandSlugs`) has to derive a slug from what a row would PASTE, and it must be the SAME
 * slug this guard will look up at submit. A second regex there disagreed with this one on every
 * name outside `[A-Za-z0-9_:-]` — a Cyrillic name in the app's own Russian locale produced no
 * allowlist entry at all, a dotted one a truncated entry — so the menu offered a command that the
 * submit then refused as unknown (S40 F4, the S11 defect by another route). One reader cannot
 * disagree with itself.
 */
export function readLeadingSlashCommand(text: string): LeadingSlashCommand | null {
  const match = LEADING_SLASH_COMMAND.exec(text.trim());
  if (!match?.[1]) return null;
  return { slug: match[1].toLowerCase(), rest: match[2]?.trim() ?? "" };
}

/**
 * Submit-time guard for qwen-kind threads. Three outcomes:
 *   - no leading `/command`, or a known slug → the input passes verbatim;
 *   - unknown slug with trailing text → the `/slug` is stripped, the rest is sent;
 *   - bare unknown slug → `null`: the caller must ABORT the submit (qwen would
 *     answer the raw command with a -32603 protocol error).
 *
 * A slug is "known" if it is a built-in (`KNOWN_QWEN_SLASH_COMMAND_SLUGS`) OR a
 * live catalog custom command (`catalogCommandSlugs`, deployed under .qwen/commands).
 * Both are matched case-insensitively (pass lowercase slugs in `catalogCommandSlugs`).
 *
 * The line is read by {@link readLeadingSlashCommand}, which is also what builds the plugin
 * allowlist passed in here — so the two cannot disagree about what the command's name IS.
 */
export function stripUnknownLeadingSlashCommand(
  text: string,
  catalogCommandSlugs?: ReadonlySet<string>,
): string | null {
  const command = readLeadingSlashCommand(text);
  if (command === null) return text;
  if (KNOWN_QWEN_SLASH_COMMAND_SLUGS.has(command.slug) || catalogCommandSlugs?.has(command.slug)) {
    return text;
  }
  return command.rest === "" ? null : command.rest;
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
  /** ru-code: live set of catalog custom-command slugs (lowercased) deployed for the active project;
   *  passed so a `/mycommand` from the Commands panel is recognized instead of aborted as "unknown". */
  readonly catalogCommandSlugs?: ReadonlySet<string>;
}): QwenSubmitPromptDecision {
  if (input.selectedProvider !== QWEN_KIND) {
    return { action: "send", prompt: input.prompt };
  }
  if (!input.hasNonTextContent && isBareCompressCommand(input.prompt)) {
    return { action: "compact" };
  }
  const strippedPrompt = stripUnknownLeadingSlashCommand(input.prompt, input.catalogCommandSlugs);
  if (strippedPrompt === null) {
    return input.hasNonTextContent ? { action: "send", prompt: "" } : { action: "abort" };
  }
  return { action: "send", prompt: strippedPrompt };
}
