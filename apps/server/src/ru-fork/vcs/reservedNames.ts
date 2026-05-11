// ru-fork: Windows reserved device names can't be read by `git add` — one
// of them aborts the whole `git add -A` (exit 128; --ignore-errors does NOT
// rescue it). They show up as junk in Git Bash when a tool runs `cmd > nul`.
// Exclude them via pathspec so git never opens them and the rest of the tree
// still stages. Win32-only: on mac/Linux these are legitimate filenames and
// excluding them would silently drop real files.
// See ru-fork-instrumental/changes/git-issues.md.

const RESERVED_NAMES = ["con", "prn", "aux", "nul"] as const;

export const WINDOWS_RESERVED_EXCLUDES: ReadonlyArray<string> =
  process.platform === "win32"
    ? RESERVED_NAMES.flatMap((name) => [
        `:(exclude,icase)${name}`, // root, bare
        `:(exclude,icase)**/${name}`, // any depth, bare
      ])
    : [];
