// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  expandRuntimeBaseDir,
  resolveChatsDir,
  resolveTranscriptBaseDir,
  resolveTranscriptFilePath,
  sanitizeCwd,
  type TranscriptBaseInput,
} from "../../../src/ru-fork/qwen-transcript/paths.ts";

const base = (overrides: Partial<TranscriptBaseInput>): TranscriptBaseInput => ({
  env: {},
  cliConfigDir: "/home/user/.qwen",
  cwd: "/work/project",
  runtimeOutputDirSetting: undefined,
  ...overrides,
});

describe("sanitizeCwd", () => {
  it("replaces every non-alphanumeric character with a hyphen", () => {
    expect(sanitizeCwd("/Users/x/My Project.v2")).toBe("-Users-x-My-Project-v2");
  });

  it("preserves alphanumerics", () => {
    expect(sanitizeCwd("abc123")).toBe("abc123");
  });

  it("lowercases on win32", () => {
    expect(sanitizeCwd("C:\\Foo", "win32")).toBe("c--foo");
  });
});

describe("expandRuntimeBaseDir", () => {
  it("expands a bare tilde to the home directory", () => {
    expect(expandRuntimeBaseDir("~", "/work")).toBe(os.homedir());
  });

  it("expands ~/segment relative to home", () => {
    expect(expandRuntimeBaseDir("~/foo/bar", "/work")).toBe(path.join(os.homedir(), "foo", "bar"));
  });

  it("expands ~\\segment (backslash) relative to home", () => {
    expect(expandRuntimeBaseDir("~\\foo", "/work")).toBe(path.join(os.homedir(), "foo"));
  });

  it("resolves a relative path against cwd", () => {
    expect(expandRuntimeBaseDir("out/dir", "/work")).toBe("/work/out/dir");
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandRuntimeBaseDir("/abs/dir", "/work")).toBe("/abs/dir");
  });
});

describe("resolveTranscriptBaseDir", () => {
  it("prefers an absolute QWEN_RUNTIME_DIR env var", () => {
    expect(resolveTranscriptBaseDir(base({ env: { QWEN_RUNTIME_DIR: "/custom/runtime" } }))).toBe(
      "/custom/runtime",
    );
  });

  it("expands a tilde QWEN_RUNTIME_DIR", () => {
    expect(resolveTranscriptBaseDir(base({ env: { QWEN_RUNTIME_DIR: "~/rt" } }))).toBe(
      path.join(os.homedir(), "rt"),
    );
  });

  it("resolves a relative QWEN_RUNTIME_DIR against cwd", () => {
    expect(
      resolveTranscriptBaseDir(base({ env: { QWEN_RUNTIME_DIR: "rt" }, cwd: "/c" })),
    ).toBe("/c/rt");
  });

  it("ignores a whitespace-only QWEN_RUNTIME_DIR and falls through", () => {
    expect(resolveTranscriptBaseDir(base({ env: { QWEN_RUNTIME_DIR: "   " } }))).toBe(
      "/home/user/.qwen",
    );
  });

  it("uses the runtimeOutputDir setting when no env var", () => {
    expect(resolveTranscriptBaseDir(base({ runtimeOutputDirSetting: "/setting/dir" }))).toBe(
      "/setting/dir",
    );
  });

  it("expands a relative runtimeOutputDir setting against cwd", () => {
    expect(
      resolveTranscriptBaseDir(base({ runtimeOutputDirSetting: "rel", cwd: "/c" })),
    ).toBe("/c/rel");
  });

  it("falls back to cliConfigDir when nothing is set", () => {
    expect(resolveTranscriptBaseDir(base({}))).toBe("/home/user/.qwen");
  });
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
