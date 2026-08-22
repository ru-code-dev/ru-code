// ru-code: version-dir garbage collection — the "max 2 versions on disk" invariant. Automatic,
// no user control (user decision). Two call points:
//   · after a verified fetch: the incoming version has landed, so every versions/<v> except the
//     running one and the incoming one is dropped (⇒ exactly [current, incoming] remain). It runs
//     AFTER, not before: the keep-list is the guarantee, and a version cannot be kept by name
//     before it exists. The cost is stated rather than hidden — during a fetch `versions/` can
//     transiently hold three trees plus the workspaces;
//   · at boot-confirm: the freshly booted server, after the journal settles to `ok`, drops every
//     versions/<v> except itself (⇒ exactly [current] until the next download).
// Deletion is only ever by explicit keep-list; an empty keep-list is a programming error and
// deletes nothing. Both update workspaces (`updates/tmp`, `updates/git`) are wiped at every call.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const VERSIONS_DIRNAME = "versions";
export const UPDATES_TMP_RELATIVE = "updates/tmp";
/**
 * Where the git channel lands the release tarball it pulls out of the repository. It is a
 * SIBLING of {@link UPDATES_TMP_RELATIVE}, not a child: `fetchVersionToDisk` wipes its own workspace
 * the moment it starts, which would delete the very archive it was handed. Wiped by every GC pass
 * and by the install run itself, so an interrupted press leaves nothing behind.
 */
export const UPDATES_GIT_RELATIVE = "updates/git";

/**
 * Delete every `<appRoot>/versions/<dir>` whose name is not in `keepVersions`, and wipe the
 * download workspace. Best-effort: individual removal failures are logged, never thrown — a held
 * handle on Windows must not break the run; the next GC pass converges.
 */
export const collectVersionGarbage = (params: {
  readonly appRoot: string;
  readonly keepVersions: ReadonlyArray<string>;
}): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (params.keepVersions.length === 0) {
      yield* Effect.logError("[auto-update] gc refused: empty keep-list", {
        appRoot: params.appRoot,
      });
      return;
    }
    const keep = new Set(params.keepVersions);
    const versionsDir = path.join(params.appRoot, VERSIONS_DIRNAME);
    const entries = yield* fs.readDirectory(versionsDir).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      const target = path.join(versionsDir, entry);
      yield* fs
        .remove(target, { recursive: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("[auto-update] gc remove failed", { target, cause: error }),
          ),
        );
    }
    for (const relative of [UPDATES_TMP_RELATIVE, UPDATES_GIT_RELATIVE]) {
      const workspace = path.join(params.appRoot, relative);
      yield* fs.remove(workspace, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
    }
  });
