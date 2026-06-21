// @effect-diagnostics nodeBuiltinImport:off
// ru-fork: deterministic resolver for qwen's on-disk transcript FILE. The runtime
// base-dir priority + sanitizeCwd live in common/cliRuntimeRoots.ts (shared with the
// stats scanner so they cannot drift); this module only shapes the per-thread path
// `<base>/projects/<sanitizeCwd(cwd)>/chats/<sessionId>.jsonl`.
import * as path from "node:path";

import {
  CHATS_DIRNAME,
  PROJECTS_DIRNAME,
  type RuntimeBaseInput,
  resolveRuntimeBaseDir,
  sanitizeCwd,
} from "../common/cliRuntimeRoots.ts";

export interface TranscriptBaseInput extends RuntimeBaseInput {
  /** thread cwd (worktreePath ?? workspaceRoot) — always known for a transcript read. */
  readonly cwd: string;
}

/** `<base>/projects/<sanitizeCwd(cwd)>/chats`. */
export const resolveChatsDir = (input: TranscriptBaseInput): string =>
  path.join(resolveRuntimeBaseDir(input), PROJECTS_DIRNAME, sanitizeCwd(input.cwd), CHATS_DIRNAME);

/** `<chatsDir>/<sessionId>.jsonl`. */
export const resolveTranscriptFilePath = (
  input: TranscriptBaseInput & { readonly sessionId: string },
): string => path.join(resolveChatsDir(input), `${input.sessionId}.jsonl`);
