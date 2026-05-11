// ru-fork: SubagentScanner service tag + interface.
//
// Mirrors SkillScannerService but with three buckets: `builtin` is a
// static snapshot of cli-code's BuiltinAgentRegistry, `user` and
// `project` come from the filesystem scanner.

import type { ServerProviderSubagent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export interface SubagentsForCwdResult {
  readonly builtin: ReadonlyArray<ServerProviderSubagent>;
  readonly user: ReadonlyArray<ServerProviderSubagent>;
  readonly project: ReadonlyArray<ServerProviderSubagent>;
}

export type SubagentScannerEnv = FileSystem.FileSystem | Path.Path;

export interface SubagentScannerShape {
  /**
   * Read the latest known subagents for a cwd. Returns cached values
   * when fresh; on cache miss or stale entry, scans synchronously and
   * writes the cache. `cwd: null` skips the project scan and returns
   * builtin + user only.
   */
  readonly getSubagentsForCwd: (
    cwd: string | null,
  ) => Effect.Effect<SubagentsForCwdResult, never, SubagentScannerEnv>;

  /**
   * Force a re-scan of the user-level root and (when cwd is non-null)
   * the project root. Used by the `/refresh-subagents` composer command.
   */
  readonly refreshSubagentsForCwd: (
    cwd: string | null,
  ) => Effect.Effect<SubagentsForCwdResult, never, SubagentScannerEnv>;
}

export class SubagentScanner extends Context.Service<SubagentScanner, SubagentScannerShape>()(
  "ru-fork/SubagentScanner",
) {}
