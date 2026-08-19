/**
 * ru-code: Windows reserved device names (`con`, `prn`, `aux`, `nul`) cannot
 * be opened by git — a single one in the tree aborts the whole `git add -A`
 * with exit 128 (`--ignore-errors` does NOT rescue it), which kills the
 * checkpoint snapshot (no diff chip / revert for the turn) and commit staging.
 * They show up as junk when a tool runs `cmd > nul` under Git Bash. Exclude
 * them via pathspec so git never opens them and the rest of the tree still
 * stages.
 *
 * Win32-only: on mac/Linux these are legitimate filenames and excluding them
 * would silently drop real files.
 *
 * @module ru-code/vcs/reservedNames
 */

import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const RESERVED_NAMES = ["con", "prn", "aux", "nul"] as const;

/** Exposed with an injectable platform so the construction is testable everywhere. */
export function windowsReservedExcludesFor(platform: NodeJS.Platform): ReadonlyArray<string> {
  if (platform !== "win32") {
    return [];
  }
  return RESERVED_NAMES.flatMap((name) => [
    `:(exclude,icase)${name}`, // root, bare
    `:(exclude,icase)**/${name}`, // any depth, bare
  ]);
}

/** The excludes for the RUNNING host (via the injectable platform reference). */
export const windowsReservedExcludes: Effect.Effect<ReadonlyArray<string>> = Effect.map(
  HostProcessPlatform,
  windowsReservedExcludesFor,
);
