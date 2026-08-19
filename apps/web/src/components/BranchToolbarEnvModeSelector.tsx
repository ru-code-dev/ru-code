import { FolderGit2Icon, FolderGitIcon, FolderIcon, HistoryIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { type EnvMode } from "./BranchToolbar.logic";
// ru-code: the workspace option + folder-glyph mapping is one pure model (R6).
import {
  resolveEnvModeSelectorItems,
  resolveEnvModeTriggerIcon,
  resolveLockedEnvMode,
  type EnvFolderIcon,
} from "../ru-code/branchToolbar/envModeControls";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
}

// ru-code: named glyph → lucide component, so the pure model stays icon-free.
const ENV_FOLDER_ICON: Record<EnvFolderIcon, typeof FolderIcon> = {
  "worktree-new": FolderGit2Icon,
  "worktree-checkout": FolderGitIcon,
  local: FolderIcon,
  history: HistoryIcon,
};

function EnvFolderGlyph({ icon }: { icon: EnvFolderIcon }) {
  const Icon = ENV_FOLDER_ICON[icon];
  return <Icon className="size-3" />;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () =>
      resolveEnvModeSelectorItems({
        activeWorktreePath,
        showPreviousWorktree,
        previousWorktreeLabel,
      }),
    [activeWorktreePath, previousWorktreeLabel, showPreviousWorktree],
  );

  if (envLocked) {
    const locked = resolveLockedEnvMode(activeWorktreePath);
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvFolderGlyph icon={locked.icon} />
        {locked.label}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-medium"
        aria-label="Workspace"
        data-composer-context-control
      >
        <EnvFolderGlyph icon={resolveEnvModeTriggerIcon(effectiveEnvMode, activeWorktreePath)} />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          {envModeItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <span className="inline-flex items-center gap-1.5">
                <EnvFolderGlyph icon={item.icon} />
                {item.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
