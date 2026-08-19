// ru-code: the branch-toolbar workspace (env-mode) selector's option + folder-glyph
// mapping. BranchToolbarEnvModeSelector renders its Select items, trigger glyph and the
// locked pill straight from these, so pinning the worktree-aware labels + which glyph
// each surface shows here locks the real behaviour (checkout vs worktree), not markup.
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvModeSelectorItems,
  resolveEnvModeTriggerIcon,
  resolveLockedEnvMode,
} from "../../branchToolbar/envModeControls";

describe("resolveEnvModeSelectorItems — the workspace options", () => {
  it("no active worktree: plain local checkout + new-worktree option", () => {
    expect(resolveEnvModeSelectorItems({ activeWorktreePath: null })).toEqual([
      { value: "local", label: "Current checkout", icon: "local" },
      { value: "worktree", label: "New worktree", icon: "worktree-new" },
    ]);
  });

  it("active worktree: the local side reads/looks like the current worktree", () => {
    expect(resolveEnvModeSelectorItems({ activeWorktreePath: "/repo/.wt/x" })).toEqual([
      { value: "local", label: "Current worktree", icon: "worktree-checkout" },
      { value: "worktree", label: "New worktree", icon: "worktree-new" },
    ]);
  });

  // ru-code: t3's "jump back to the previous worktree" third option.
  it("with a previous worktree to go back to: a third history-glyph option is appended", () => {
    expect(
      resolveEnvModeSelectorItems({
        activeWorktreePath: null,
        showPreviousWorktree: true,
        previousWorktreeLabel: "feature/x",
      }),
    ).toEqual([
      { value: "local", label: "Current checkout", icon: "local" },
      { value: "worktree", label: "New worktree", icon: "worktree-new" },
      { value: "previous-worktree", label: "feature/x", icon: "history" },
    ]);
  });

  it("showPreviousWorktree without a label does not append the third option", () => {
    expect(
      resolveEnvModeSelectorItems({
        activeWorktreePath: null,
        showPreviousWorktree: true,
        previousWorktreeLabel: null,
      }),
    ).toHaveLength(2);
  });
});

describe("resolveEnvModeTriggerIcon — glyph for the effective mode", () => {
  it("worktree mode always shows the new-worktree glyph", () => {
    expect(resolveEnvModeTriggerIcon("worktree", null)).toBe("worktree-new");
    expect(resolveEnvModeTriggerIcon("worktree", "/repo/.wt/x")).toBe("worktree-new");
  });

  it("local mode shows checkout glyph only while a worktree is active", () => {
    expect(resolveEnvModeTriggerIcon("local", null)).toBe("local");
    expect(resolveEnvModeTriggerIcon("local", "/repo/.wt/x")).toBe("worktree-checkout");
  });
});

describe("resolveLockedEnvMode — read-only pill", () => {
  it("labels + glyphs the locked workspace by whether a worktree is active", () => {
    expect(resolveLockedEnvMode(null)).toEqual({ label: "Local checkout", icon: "local" });
    expect(resolveLockedEnvMode("/repo/.wt/x")).toEqual({
      label: "Worktree",
      icon: "worktree-checkout",
    });
  });
});
