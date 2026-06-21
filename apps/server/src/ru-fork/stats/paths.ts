// @effect-diagnostics nodeBuiltinImport:off
// ru-fork: GLOBAL projects-root resolver (all sessions, across every project) for the
// stats scan. The runtime base-dir priority lives in common/cliRuntimeRoots.ts (shared
// with the advanced-chat transcript reader), so a global scan and a single-thread read
// always agree on the base. A global scan has no per-thread cwd, so it omits it — the
// runtimeOutputDir setting tier is intentionally not wired here (Scope A).
import * as path from "node:path";

import { CHATS_DIRNAME, PROJECTS_DIRNAME, resolveRuntimeBaseDir } from "../common/cliRuntimeRoots.ts";

export interface StatsBaseInput {
  readonly env: NodeJS.ProcessEnv;
  /** ServerConfig.cliConfigDir = {home}/$CLI_DIR = qwen's default runtime base. */
  readonly cliConfigDir: string;
}

/** `<runtimeBase>/projects` — the root that holds every project's chat directory. */
export const resolveProjectsRoot = (input: StatsBaseInput): string =>
  path.join(
    resolveRuntimeBaseDir({ env: input.env, cliConfigDir: input.cliConfigDir }),
    PROJECTS_DIRNAME,
  );

/** `<projectsRoot>/<projectDir>/chats`. */
export const chatsDirFor = (projectsRoot: string, projectDir: string): string =>
  path.join(projectsRoot, projectDir, CHATS_DIRNAME);

/** Classify a real cwd path as a throwaway temp/sandbox dir. */
export const isTempCwd = (cwd: string): boolean =>
  cwd.startsWith("/var/folders/") ||
  cwd.startsWith("/private/var/folders/") ||
  cwd.startsWith("/tmp/") ||
  cwd.startsWith("/private/tmp/");

/** Human label = last non-empty path segment of the real cwd. */
export const projectLabelFor = (cwd: string): string => {
  const segments = cwd.split(/[/\\]+/).filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  return lastSegment ?? cwd;
};
