// ru-code (cli-reload): the delete step — owner ruling R3.
//
// Each `DELETE_ON_CLI_RESTART` entry is a RELATIVE path spelled with posix `/` separators
// (branding cliReset.ts). There is no precedent in this repo for splitting a posix-spelled
// relative path into native segments (research D-G2: every `split("/")` under apps/server,
// ru-code, ru-code-packages and packages is a URL / ref / repo-name parser, never a
// filesystem path), so the shape is introduced here, once, and every caller goes through it:
//
//   path.join(dir, ...entry.split("/"))
//
// Removal is `recursive: true, force: true` — file or directory, missing ignored — which is
// the exact idiom the warm-slot overlay sweep already uses (QwenAdapter.ts:979
// `fileSystem.remove(warmDir, { recursive: true, force: true })`).
//
// Dirs arrive DEDUPLICATED and `~`-expanded from the caller: two configured qwen instances
// sharing one profile dir must not delete the same tree twice (research G11).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface CliResetDeleteInput {
  /** Resolved profile dirs, already `~`-expanded and deduplicated. Empty strings are skipped. */
  readonly dirs: ReadonlyArray<string>;
  /** `DELETE_ON_CLI_RESTART` — relative, posix-spelled. Empty entries are skipped. */
  readonly entries: ReadonlyArray<string>;
}

/**
 * Remove every `entries` path under every `dirs` path. Never fails: a delete problem must not
 * fail the reload the user is watching (the cause is logged at debug, owner ruling R7).
 */
export const removeCliResetEntries = (
  input: CliResetDeleteInput,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (input.dirs.length === 0 || input.entries.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const dir of input.dirs) {
      if (dir.length === 0) continue;
      for (const entry of input.entries) {
        // A trailing "/" (a directory spelling) and any doubled separator collapse away here;
        // an entry that is nothing but separators leaves no segments and is skipped, so the
        // profile dir itself can never become the target.
        const segments = entry.split("/").filter((segment) => segment.length > 0);
        const target = path.join(dir, ...segments);
        // THE containment check. `path.join` happily resolves `..` upward, so an entry of `..`
        // targets the profile dir's PARENT — on the production shape `<home>/.qwen` that is the
        // user's entire home directory, removed `recursive, force` (adversary A-4). Everything
        // this step removes must be INSIDE the dir, and `path.relative` is the only honest test
        // of that: `""` means the dir itself and an absolute result means a different root.
        //
        // "Starts with `..`" is NOT that test — it also rejects `..cache`, a perfectly ordinary
        // entry that resolves inside the dir (adversary R2-3). Outside is `..` exactly, or `..`
        // followed by a separator; anything else beginning with dots is just a filename.
        const inside = path.relative(dir, target);
        const escapes =
          inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside);
        if (inside === "" || escapes) {
          yield* Effect.logWarning("[cli-reload] refusing an entry that escapes the profile dir", {
            dir,
            entry,
          });
          continue;
        }
        yield* Effect.logDebug("[cli-reload] removing profile-dir entry", { target });
        yield* Effect.ignore(fileSystem.remove(target, { recursive: true, force: true }));
      }
    }
  });
