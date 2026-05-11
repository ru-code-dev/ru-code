// ru-fork: SkillScanner service tag + interface.
//
// The single consumer-facing surface for the filesystem skill scanner.
// `getSkillsForCwd(null)` returns globals only (used when a virtual
// chat is opened without a known cwd, e.g., from the home screen).

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export interface SkillsForCwdResult {
  readonly global: ReadonlyArray<ServerProviderSkill>;
  readonly project: ReadonlyArray<ServerProviderSkill>;
}

export type SkillScannerEnv = FileSystem.FileSystem | Path.Path;

export interface SkillScannerShape {
  /**
   * Read the latest known skills for a cwd. Returns cached values when
   * fresh; on cache miss or stale entry, scans synchronously and writes
   * the cache. `cwd: null` skips the project scan and returns globals
   * only.
   */
  readonly getSkillsForCwd: (
    cwd: string | null,
  ) => Effect.Effect<SkillsForCwdResult, never, SkillScannerEnv>;

  /**
   * Force a re-scan of the global root and (when cwd is non-null) the
   * project root. Used by the `/refresh-skills` composer command.
   */
  readonly refreshSkillsForCwd: (
    cwd: string | null,
  ) => Effect.Effect<SkillsForCwdResult, never, SkillScannerEnv>;
}

export class SkillScanner extends Context.Service<SkillScanner, SkillScannerShape>()(
  "ru-fork/SkillScanner",
) {}
