// ru-code: the composer's `/` menu content as ONE testable composite — the
// app's built-in commands, the preconfigured qwen commands (kind-gated), the
// provider-advertised commands, and the search filter, in the exact order the
// picker renders. Extracted from ChatComposer's trigger memo so the assembled
// list (not just its fragments) is pinned by tests.
import { type ProviderDriverKind, type ServerProviderSlashCommand } from "@t3tools/contracts";

import { type ComposerCommandItem } from "../../components/chat/ComposerCommandMenu";
import { searchSlashCommandItems } from "../../components/chat/composerSlashCommandSearch";
import { buildQwenSlashCommandItems } from "./qwenSlashCommands";

export function buildComposerSlashCommandMenuItems(input: {
  readonly selectedProvider: ProviderDriverKind;
  readonly providerSlashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
  /** True while composing a DRAFT (no thread yet) — disables /compress. */
  readonly isDraftThread?: boolean;
}): ComposerCommandItem[] {
  // ru-code: built-ins HIDDEN for now (product decision 2026-07-21) — set to false to restore.
  // Runtime filter (not commenting/DCE): the strings must stay in the bundle so the
  // localization dict entries keep matching (the build fails on orphaned translations).
  const HIDE_BUILTIN_SLASH_COMMANDS = true;
  const builtInSlashCommandItems = (
    [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model for this thread",
      },
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch this thread into plan mode",
      },
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
    ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>
  ).filter(() => !HIDE_BUILTIN_SLASH_COMMANDS);
  const providerSlashCommandItems = input.providerSlashCommands.map((command) => ({
    id: `provider-slash-command:${input.selectedProvider}:${command.name}`,
    type: "provider-slash-command" as const,
    provider: input.selectedProvider,
    command,
    label: `/${command.name}`,
    description: command.description ?? command.input?.hint ?? "Run provider command",
  }));
  const query = input.query.trim().toLowerCase();
  const slashCommandItems = [
    ...builtInSlashCommandItems,
    // Preconfigured qwen commands (init/summary/compress/review), present
    // ONLY when the selected kind is the CLI kind (any profile).
    ...buildQwenSlashCommandItems(input.selectedProvider, {
      isDraftThread: input.isDraftThread ?? false,
    }),
    ...providerSlashCommandItems,
  ];
  if (!query) {
    return slashCommandItems;
  }
  return searchSlashCommandItems(slashCommandItems, query);
}
