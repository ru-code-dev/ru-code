// @effect-diagnostics nodeBuiltinImport:off
// ru-fork: single source for the CLI's RUNTIME base dir + transcript tree layout.
// Both the advanced-chat transcript reader (qwen-transcript) and the global stats
// scanner resolve `<base>/projects/<dir>/chats/` from here, so the brand-coupled
// base-dir priority (and the QWEN_RUNTIME_DIR env name) can never drift between them.
//
// Mirrors qwen-code core/src/config/storage.ts (getRuntimeBaseDir / getProjectDir)
// and utils/paths.ts (sanitizeCwd) EXACTLY so our resolved path === the CLI's path.
//
// Base dir priority (storage.ts:102-118):
//   QWEN_RUNTIME_DIR env > settings.advanced.runtimeOutputDir > getGlobalQwenDir()
// where getGlobalQwenDir() == os.homedir()/$CLI_DIR == ServerConfig.cliConfigDir.
import * as path from "node:path";
import * as os from "node:os";

/** Directory segment under the runtime base that holds per-project transcript trees. */
export const PROJECTS_DIRNAME = "projects";
/** Directory segment under each project that holds the `<sessionId>.jsonl` chats. */
export const CHATS_DIRNAME = "chats";

/** 1:1 port of qwen utils/paths.ts:218 sanitizeCwd. `platform` is injectable for tests. */
export const sanitizeCwd = (cwd: string, platform: NodeJS.Platform = os.platform()): string => {
  const normalized = platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
};

/**
 * 1:1 port of qwen storage.ts:40-67 resolveRuntimeBaseDir (tilde + relative).
 * A relative `dir` resolves against `cwd` when a thread cwd is known (transcript
 * reads), or against the home dir when it isn't (the global stats scan).
 */
export const expandRuntimeBaseDir = (dir: string, cwd?: string): string => {
  let resolved = dir;
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    const rest =
      resolved === "~" ? [] : resolved.slice(2).split(/[/\\]+/).filter(Boolean);
    resolved = path.join(os.homedir(), ...rest);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd ?? os.homedir(), resolved);
  }
  return resolved;
};

export interface RuntimeBaseInput {
  /** process env of THIS server (the child inherits it; QWEN_RUNTIME_DIR wins). */
  readonly env: NodeJS.ProcessEnv;
  /** ServerConfig.cliConfigDir = {home}/$CLI_DIR = qwen's default runtime base. */
  readonly cliConfigDir: string;
  /** Thread cwd when one is known (transcript reads); omitted for a global scan. */
  readonly cwd?: string | undefined;
  /** advanced.runtimeOutputDir from the CLI settings.json, if any. */
  readonly runtimeOutputDirSetting?: string | undefined;
}

/** Mirror of storage.ts:102-118 priority: env > runtimeOutputDir setting > cliConfigDir. */
export const resolveRuntimeBaseDir = (input: RuntimeBaseInput): string => {
  const fromEnv = input.env["QWEN_RUNTIME_DIR"];
  if (fromEnv && fromEnv.trim()) {
    return expandRuntimeBaseDir(fromEnv.trim(), input.cwd);
  }
  const setting = input.runtimeOutputDirSetting?.trim();
  if (setting) {
    return expandRuntimeBaseDir(setting, input.cwd);
  }
  return input.cliConfigDir;
};
