import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { BotIcon, PuzzleIcon } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, type ComponentType } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { formatProviderSkillInstallSource } from "~/providerSkillPresentation";
import { cn } from "~/lib/utils";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";
// ru-code: one section per plugin (labelled with the plugin's display name) for `plugin-item` rows.
import { groupPluginComposerItems } from "~/ru-code/plugins/composerMenuGroups";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
      // ru-code: grayed + unselectable (e.g. /compress while composing a draft).
      disabled?: boolean;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  // ru-code: a row contributed by a dropped-in plugin (mvp-plan D7). It rides one of the three
  // EXISTING triggers — `command` → `/`, `skill` → `$`, `agent` → `#` — and inserts a prompt,
  // so no new trigger and no new Lexical node exist. `prompt` may be async: the insert is
  // guarded by `expectedText`, which makes a stale resolution a no-op (mvp-plan §6 risk 2).
  | {
      id: string;
      type: "plugin-item";
      trigger: "command" | "skill" | "agent";
      pluginId: string;
      name: string;
      label: string;
      description: string;
      prompt: string | (() => Promise<string>);
      // ru-code (A22, SDK 0.3.0): a row from `composer.registerProvider` may name its own SECTION
      // and its own glyph. Both are optional and absent on every `registerItem` row, so the
      // existing grouping (one section per plugin, labelled with the plugin's display name) and
      // the existing puzzle glyph are unchanged for every plugin that predates the provider port.
      //
      // WHY THE THREE `catalog-*` VARIANTS COLLAPSED INTO THIS ONE (A25). They differed from
      // `plugin-item` in exactly these two fields — a `scope` that chose a section label and a
      // hard-coded glyph per kind — and in nothing else: their insert text was the row's own, and
      // `plugin-item`'s insert branch already pastes arbitrary text through the same
      // `expectedText` guard. The plugin that owns those catalogs therefore needed no new row type,
      // no new trigger and no new Lexical node (PHASE3 plan §2.5.3).
      group?: string;
      icon?: ComponentType<{ className?: string; size?: number | string; strokeWidth?: number }>;
      // ru-code (A22): who owns the trailing space.
      //
      // A `registerItem` row's `prompt` is a PROMPT — the SDK has always documented that the host
      // pastes `` `${prompt} ` ``, and every plugin shipped so far relies on it. A PROVIDER row's
      // `insert` is "the exact text pasted", because a catalog token (`skill:⟦name⟧ `) and a
      // command (`/name `) space themselves differently and only the plugin knows which. So the
      // rule travels WITH the row instead of being guessed from the trigger: `true` ⇒ paste
      // `insert` byte for byte, absent ⇒ the historical `prompt + " "`.
      insertVerbatim?: boolean;
    };

type ComposerCommandGroup = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

function SkillGlyph(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroup[] {
  // ru-code: skill/agent pickers. A plugin's rows carry their own section label (a catalog
  // provider names Проект / Глобальные / Встроенные), so the sectioning is one delegate; the app's
  // own native provider rows have no `group` and fall back to the single flat group below.
  if (triggerKind === "skill" || triggerKind === "subagent") {
    // ru-code: plugin rows get their own section per plugin, after the app's own sections.
    const pluginGroups = groupPluginComposerItems(items);
    const ownItems = items.filter((item) => item.type !== "plugin-item");
    const ownGroups =
      ownItems.length > 0
        ? [
            {
              id: triggerKind,
              label: triggerKind === "skill" ? "Skills" : "Agents",
              items: ownItems,
            },
          ]
        : [];
    return [...ownGroups, ...pluginGroups];
  }
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-slash-command");

  const groups: ComposerCommandGroup[] = [];
  // ru-code: a dropped-in plugin's `/` rows lead the menu, one section per plugin — which since
  // A25 is where the catalog's custom commands (Проект / Глобальные) arrive too.
  for (const pluginGroup of groupPluginComposerItems(items)) {
    groups.push(pluginGroup);
  }
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  return groups;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () =>
      groupCommandItems(props.items, props.triggerKind, props.groupSlashCommandSections ?? true),
    [props.groupSlashCommandSections, props.items, props.triggerKind],
  );

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className="dropdown-glass relative w-full overflow-hidden rounded-[20px] shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
      >
        {props.items.length > 0 ? (
          <CommandList className="max-h-72 not-empty:py-3">
            {groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
                <CommandGroup>
                  {group.label ? (
                    <CommandGroupLabel className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
                      {group.label}
                    </CommandGroupLabel>
                  ) : null}
                  {group.items.map((item) => (
                    <ComposerCommandMenuItem
                      key={item.id}
                      item={item}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  ))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        ) : (
          <div className="px-5 py-3.5">
            {props.triggerKind === "skill" ? (
              <CommandGroup>
                <CommandGroupLabel className="px-0 pt-0 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
                  Skills
                </CommandGroupLabel>
                <p className="text-secondary-label text-xs">
                  {props.isLoading
                    ? "Searching workspace skills..."
                    : (props.emptyStateText ??
                      "No skills found. Try / to browse provider commands.")}
                </p>
              </CommandGroup>
            ) : (
              <p className="text-secondary-label text-xs">
                {props.isLoading
                  ? "Searching workspace files..."
                  : (props.emptyStateText ??
                    (props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
              </p>
            )}
          </div>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceLabel =
    props.item.type === "skill" ? formatProviderSkillInstallSource(props.item.skill) : null;
  // ru-code: disabled items render gray and never select/highlight.
  const itemDisabled = props.item.type === "provider-slash-command" && props.item.disabled === true;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      disabled={itemDisabled}
      className={cn(
        "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
        itemDisabled && "cursor-default opacity-50",
      )}
      onMouseMove={() => {
        if (!props.isActive && !itemDisabled) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        if (itemDisabled) return;
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-4 shrink-0 text-icon-muted" />
      ) : null}
      {props.item.type === "provider-slash-command" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-icon-muted">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      {props.item.type === "skill" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-icon-muted">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      {/* ru-code: a plugin's row. A22: a provider row may carry its OWN glyph (`icon`); the
          puzzle glyph the plugin family uses everywhere is the fallback, so every `registerItem`
          row and every provider row that did not ask for one look exactly as they did before.
          The component is already wrapped in the plugin's icon boundary by `hostApi.ts`, so a
          throwing glyph degrades to the failure triangle rather than to the menu. */}
      {props.item.type === "plugin-item" ? <PluginRowIcon icon={props.item.icon} /> : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">{props.item.label}</span>
        <span className="min-w-0 flex-1 truncate text-secondary-label text-xs">
          {props.item.description}
        </span>
      </span>
      {skillSourceLabel ? (
        <span className="shrink-0 pl-2 text-secondary-label text-xs">{skillSourceLabel}</span>
      ) : null}
    </CommandItem>
  );
});

/** ru-code (A22): a plugin composer row's glyph — its own, or the plugin family's puzzle. */
function PluginRowIcon({
  icon: Icon,
}: {
  readonly icon:
    | ComponentType<{ className?: string; size?: number | string; strokeWidth?: number }>
    | undefined;
}) {
  if (Icon === undefined) return <PuzzleIcon className="size-4 shrink-0 text-icon-muted" />;
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center text-icon-muted">
      <Icon className="size-3.5" />
    </span>
  );
}
