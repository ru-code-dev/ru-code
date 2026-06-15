// @effect-diagnostics nodeBuiltinImport:off
// ru-fork: deterministic resolver for qwen's on-disk transcript file. Mirrors
// qwen-code core/src/config/storage.ts (getRuntimeBaseDir / getProjectDir) and
// utils/paths.ts (sanitizeCwd) EXACTLY so our resolved path === the CLI's path.
//
// Base dir priority (storage.ts:102-118):
//   QWEN_RUNTIME_DIR env > settings.advanced.runtimeOutputDir > getGlobalQwenDir()
// where getGlobalQwenDir() == os.homedir()/$CLI_DIR == ServerConfig.cliConfigDir.
// We use `cliConfigDir` for the default so the base tracks our resolved CLI
// config dir (the same root the skills scanner reads), never a literal ".qwen".
import * as path from "node:path";
import * as os from "node:os";

/** 1:1 port of qwen utils/paths.ts:218 sanitizeCwd. `platform` is injectable for tests. */
export const sanitizeCwd = (cwd: string, platform: NodeJS.Platform = os.platform()): string => {
  const normalized = platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
};

/** 1:1 port of qwen storage.ts:40-67 resolveRuntimeBaseDir (tilde + relative). */
export const expandRuntimeBaseDir = (dir: string, cwd: string): string => {
  let resolved = dir;
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    const rest =
      resolved === "~" ? [] : resolved.slice(2).split(/[/\\]+/).filter(Boolean);
    resolved = path.join(os.homedir(), ...rest);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd, resolved);
  }
  return resolved;
};

export interface TranscriptBaseInput {
  /** process env of THIS server (the child inherits it; QWEN_RUNTIME_DIR wins). */
  readonly env: NodeJS.ProcessEnv;
  /** ServerConfig.cliConfigDir = {home}/$CLI_DIR = qwen's default runtime base. */
  readonly cliConfigDir: string;
  /** thread cwd (worktreePath ?? workspaceRoot). */
  readonly cwd: string;
  /** advanced.runtimeOutputDir from the CLI settings.json, if any. */
  readonly runtimeOutputDirSetting: string | undefined;
}

/** Mirror of storage.ts:102-118 priority. */
export const resolveTranscriptBaseDir = (input: TranscriptBaseInput): string => {
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

/** `<base>/projects/<sanitizeCwd(cwd)>/chats`. */
export const resolveChatsDir = (input: TranscriptBaseInput): string =>
  path.join(resolveTranscriptBaseDir(input), "projects", sanitizeCwd(input.cwd), "chats");

/** `<chatsDir>/<sessionId>.jsonl`. */
export const resolveTranscriptFilePath = (
  input: TranscriptBaseInput & { readonly sessionId: string },
): string => path.join(resolveChatsDir(input), `${input.sessionId}.jsonl`);
