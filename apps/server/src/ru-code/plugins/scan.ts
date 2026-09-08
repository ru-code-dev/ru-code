/**
 * ru-code: enumerate the plugin folders under `<baseDir>/plugins/`.
 *
 * Posture copied from the skills catalog scanner
 * (`qwen-cli-skill-manager/src/server/scanSkillCatalogRoots.ts:48-70`): a missing
 * root is "no plugins", not an error; an unreadable entry is skipped; the scan
 * never throws. That is guardrail 8 — the host must survive anything a user drops
 * into the folder.
 *
 * Two deliberate differences from the skills scanner:
 *
 *  - a folder we refuse is KEPT in the result as `{ ok: false, reason }` instead
 *    of being dropped. The Plugins surface has to be able to tell the user that
 *    `demo` is present but skipped and why; a silently missing row is the worst
 *    possible answer to "I copied the folder and nothing happened".
 *  - symlink containment. `fs.stat` follows symlinks, so a symlinked entry that
 *    points anywhere on the filesystem would otherwise be scanned, executed
 *    (`server/index.mjs`) and served over HTTP as if it were inside the plugins
 *    root. Every entry's `realPath` must therefore still be under the root's own
 *    `realPath` (the root itself is resolved first, because `~/.ru-code` may
 *    legitimately be reached through a symlinked home or /tmp on macOS).
 *
 * @module ru-code/plugins/scan
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readPluginManifest, type PluginManifestEntry } from "./manifest.ts";
import { isWithinRoot } from "./paths.ts";

// ru-code (A5): the helper moved to `paths.ts` so `manifest.ts` can use it too
// without importing this module (which imports it). Re-exported here because
// this is where it was published from and the scan tests address it here.
export { isWithinRoot };

/**
 * Scan every immediate subdirectory of `pluginsDir` for a plugin manifest.
 *
 * Missing directory ⇒ `[]`. Entries are returned in directory-name order so the
 * boot log and `GET /plugins/manifests.json` are deterministic.
 */
export const scanPluginsDir = (
  pluginsDir: string,
): Effect.Effect<ReadonlyArray<PluginManifestEntry>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = yield* fs.exists(pluginsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* Effect.logDebug("ru-code plugins: no plugins directory", { dir: pluginsDir });
      return [];
    }

    // Resolve the root ONCE; every entry is compared against this, not against
    // the possibly-symlinked path the config handed us.
    const root = yield* fs
      .realPath(pluginsDir)
      .pipe(Effect.orElseSucceed(() => path.resolve(pluginsDir)));

    const names = yield* fs
      .readDirectory(pluginsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    const entries: Array<PluginManifestEntry> = [];
    for (const name of [...names].sort()) {
      const dir = path.join(pluginsDir, name);

      const real = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => null));
      if (real === null) continue;
      if (!isWithinRoot(path, root, real)) {
        // Not reported as a skipped plugin: a link out of the root is not a
        // plugin the user "installed here", and echoing the target path back to
        // the UI would leak an arbitrary filesystem location.
        yield* Effect.logWarning(
          "ru-code plugins: ignoring entry that resolves outside the plugins directory",
          {
            name,
            dir,
          },
        );
        continue;
      }

      const stat = yield* fs.stat(dir).pipe(Effect.orElseSucceed(() => null));
      if (stat === null || stat.type !== "Directory") continue;

      entries.push(yield* readPluginManifest(dir));
    }

    return entries;
  }).pipe(Effect.withSpan("plugins.scanPluginsDir", { attributes: { dir: pluginsDir } }));
