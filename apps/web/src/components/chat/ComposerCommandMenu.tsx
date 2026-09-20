import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";

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
// ru-code: plugins — one section per plugin for `plugin-item` rows, and the lucide-by-name glyph.
import { groupPluginComposerItems } from "~/ru-code/plugins/composerRows";
import { PluginIcon } from "~/ru-code/plugins/PluginIcon";
import { pluginDisplayName } from "~/ru-code/plugins/status";

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
  // ru-code: plugins — a row a dropped-in plugin contributed for one of the three EXISTING triggers —
  // `command` → `/`, `skill` → `$`, `agent` → `#`. No new trigger and no new Lexical node.
  //
  // `insert` is the EXACT text pasted, always. v1 had two rules (a registered item's prompt got a
  // trailing space appended, a provider row's did not) carried per row as `insertVerbatim`; the
  // SDK now says the author owns the trailing space, so the host has one rule and no field for it.
  // `icon` is a lucide NAME rendered by the host — plugin React never reaches this menu.
  | {
      id: string;
      type: "plugin-item";
      trigger: "command" | "skill" | "agent";
      pluginId: string;
      label: string;
      description: string;
      insert: string;
      /** Section label; absent ⇒ the plugin's own display name. */
      group?: string;
      /** A `lucide-react` icon name; unknown or absent ⇒ the plugin family's puzzle glyph. */
      icon?: string;
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
    // ru-code: plugins — plugin rows get their own section per plugin, after the app's own sections.
    const pluginGroups = groupPluginComposerItems(items, pluginDisplayName);
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
  for (const pluginGroup of groupPluginComposerItems(items, pluginDisplayName)) {
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
      {/* ru-code: plugins — the row's glyph is a lucide NAME the HOST renders (V2-6) — a plugin component
          can no longer reach this menu at all, which is what makes a throwing glyph impossible
          rather than merely wrapped. An unknown name falls back to the puzzle. */}
      {props.item.type === "plugin-item" ? <PluginRowIcon name={props.item.icon} /> : null}
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

/** ru-code: plugins — a row's glyph — the lucide icon it named, or the plugin family's puzzle. */
function PluginRowIcon({ name }: { readonly name: string | undefined }) {
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center text-icon-muted">
      <PluginIcon className="size-3.5" name={name} />
    </span>
  );
}
