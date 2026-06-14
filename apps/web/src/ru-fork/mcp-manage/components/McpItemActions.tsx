import type { ReactNode } from "react";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { RecheckButton } from "./RecheckButton";

/**
 * The MCP item's right-side control cluster — ONE fixed order/look everywhere (catalog card,
 * project card, catalog detail header): refresh → edit → delete → enable/disable switch → collapse
 * arrow. Edit is a dialog-wrapped slot (catalog uses McpServerDialog, project uses ProjectConfigDialog);
 * delete + arrow are optional (a built-in has no delete; a navigate card has no arrow). Icons are
 * neutral-ghost; only delete tints red on hover.
 */
export interface McpItemActionsProps {
  readonly recheckFilter: {
    readonly projectId?: string;
    readonly serverId?: string;
    readonly transport?: "stdio" | "http";
  };
  readonly recheckDisabled?: boolean | undefined;
  readonly recheckAriaLabel: string;
  /** Dialog-wrapped pencil trigger. Omit on the catalog list card (edit lives in the detail). */
  readonly editTrigger?: ReactNode;
  /** When provided, a trash button is shown; omit ⇒ not deletable (e.g. a built-in catalog server). */
  readonly onDelete?: (() => void) | undefined;
  readonly deleteTitle?: string | undefined;
  readonly deleteAriaLabel?: string | undefined;
  readonly enabled: boolean;
  readonly onToggleEnabled: (next: boolean) => void;
  readonly switchAriaLabel: string;
  readonly switchTitle?: string | undefined;
  /** Collapse arrow — rendered only when onToggleExpand is provided (collapsible card). */
  readonly expanded?: boolean | undefined;
  readonly onToggleExpand?: (() => void) | undefined;
}

export function McpItemActions({
  recheckFilter,
  recheckDisabled,
  recheckAriaLabel,
  editTrigger,
  onDelete,
  deleteTitle,
  deleteAriaLabel,
  enabled,
  onToggleEnabled,
  switchAriaLabel,
  switchTitle,
  expanded,
  onToggleExpand,
}: McpItemActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <RecheckButton
        filter={recheckFilter}
        disabled={recheckDisabled ?? false}
        ariaLabel={recheckAriaLabel}
      />
      {editTrigger}
      {onDelete && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="hover:text-red-600 dark:hover:text-red-300"
          title={deleteTitle ?? "Удалить"}
          aria-label={deleteAriaLabel ?? deleteTitle ?? "Удалить"}
          onClick={onDelete}
        >
          <Trash2Icon className="size-4" />
        </Button>
      )}
      <Switch
        checked={enabled}
        onCheckedChange={(value) => onToggleEnabled(Boolean(value))}
        aria-label={switchAriaLabel}
        title={switchTitle}
      />
      {onToggleExpand && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={expanded ? "Свернуть" : "Развернуть"}
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <ChevronDownIcon className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </Button>
      )}
    </div>
  );
}
