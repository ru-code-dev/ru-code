// ru-code: the branch-toolbar workspace (env-mode) selector's option + icon decision as
// one pure model, so BranchToolbarEnvModeSelector renders from data (R6) rather than
// hand-wiring each SelectItem + folder icon inline. Locks the real mapping a user sees:
// which two workspace options exist, their labels (worktree-aware), which folder glyph
// each item / the trigger / the locked pill shows. Folder icons are named here and
// mapped to components in the .tsx so this stays a plain unit.
import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "../../components/BranchToolbar.logic";

/** Which folder glyph a workspace control shows. */
export type EnvFolderIcon =
  /** A brand-new worktree (FolderGit2). */
  | "worktree-new"
  /** The current checkout while a worktree is active (FolderGit). */
  | "worktree-checkout"
  /** Plain local checkout (Folder). */
  | "local"
  /** ru-code: jump back to the previously-active worktree (History). */
  | "history";

/** ru-code: the selector's "jump back to the previous worktree" option value. */
export const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

export interface EnvModeSelectorItem {
  readonly value: EnvMode | typeof PREVIOUS_WORKTREE_SELECT_VALUE;
  readonly label: string;
  readonly icon: EnvFolderIcon;
}

/** The folder glyph for the plain (non-worktree) side, given whether a worktree is active. */
function localSideIcon(activeWorktreePath: string | null): EnvFolderIcon {
  return activeWorktreePath ? "worktree-checkout" : "local";
}

/**
 * The workspace options — local / new worktree, and, when there is one to go
 * back to, the previously-active worktree (ru-code, t3's third entry).
 */
export function resolveEnvModeSelectorItems(input: {
  readonly activeWorktreePath: string | null;
  readonly showPreviousWorktree?: boolean | undefined;
  readonly previousWorktreeLabel?: string | null | undefined;
}): ReadonlyArray<EnvModeSelectorItem> {
  const { activeWorktreePath, showPreviousWorktree, previousWorktreeLabel } = input;
  const items: EnvModeSelectorItem[] = [
    {
      value: "local",
      label: resolveCurrentWorkspaceLabel(activeWorktreePath),
      icon: localSideIcon(activeWorktreePath),
    },
    { value: "worktree", label: resolveEnvModeLabel("worktree"), icon: "worktree-new" },
  ];
  if (showPreviousWorktree && previousWorktreeLabel) {
    const previousWorktreeItem: EnvModeSelectorItem = {
      value: PREVIOUS_WORKTREE_SELECT_VALUE,
      label: previousWorktreeLabel,
      icon: "history",
    };
    items.push(previousWorktreeItem);
  }
  return items;
}

/** The trigger glyph for the currently-effective mode. */
export function resolveEnvModeTriggerIcon(
  effectiveEnvMode: EnvMode,
  activeWorktreePath: string | null,
): EnvFolderIcon {
  return effectiveEnvMode === "worktree" ? "worktree-new" : localSideIcon(activeWorktreePath);
}

/** The label + glyph for the locked (read-only) workspace pill. */
export function resolveLockedEnvMode(activeWorktreePath: string | null): {
  readonly label: string;
  readonly icon: EnvFolderIcon;
} {
  return {
    label: resolveLockedWorkspaceLabel(activeWorktreePath),
    icon: activeWorktreePath ? "worktree-checkout" : "local",
  };
}
