// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vitest";

import {
  type TranscriptBaseInput,
  resolveChatsDir,
  resolveTranscriptFilePath,
} from "../../../src/ru-fork/qwen-transcript/paths.ts";

// The runtime base-dir priority (env / runtimeOutputDir / cliConfigDir) is shared and
// tested in common/cliRuntimeRoots.test.ts; here we only cover the transcript-specific
// path shaping `<base>/projects/<sanitizeCwd(cwd)>/chats/<sessionId>.jsonl`.
const base = (overrides: Partial<TranscriptBaseInput>): TranscriptBaseInput => ({
  env: {},
  cliConfigDir: "/home/user/.qwen",
  cwd: "/work/project",
  runtimeOutputDirSetting: undefined,
  ...overrides,
});

describe("resolveChatsDir / resolveTranscriptFilePath", () => {
  it("assembles <base>/projects/<sanitizeCwd(cwd)>/chats with no tmp segment or hash", () => {
    const chatsDir = resolveChatsDir(base({ cwd: "/work/project" }));
    expect(chatsDir).toBe("/home/user/.qwen/projects/-work-project/chats");
    expect(chatsDir).not.toContain("/tmp/");
  });

  it("appends <sessionId>.jsonl", () => {
    const filePath = resolveTranscriptFilePath(base({ cwd: "/work/project", sessionId: "abc-123" }));
    expect(filePath).toBe("/home/user/.qwen/projects/-work-project/chats/abc-123.jsonl");
  });
});
