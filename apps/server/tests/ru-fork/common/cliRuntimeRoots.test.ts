// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type RuntimeBaseInput,
  expandRuntimeBaseDir,
  resolveRuntimeBaseDir,
  sanitizeCwd,
} from "../../../src/ru-fork/common/cliRuntimeRoots.ts";

const base = (overrides: Partial<RuntimeBaseInput>): RuntimeBaseInput => ({
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

  it("resolves a relative path against home when no cwd is given (global scan)", () => {
    expect(expandRuntimeBaseDir("out/dir")).toBe(path.join(os.homedir(), "out", "dir"));
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandRuntimeBaseDir("/abs/dir", "/work")).toBe("/abs/dir");
  });
});

describe("resolveRuntimeBaseDir", () => {
  it("prefers an absolute QWEN_RUNTIME_DIR env var", () => {
    expect(resolveRuntimeBaseDir(base({ env: { QWEN_RUNTIME_DIR: "/custom/runtime" } }))).toBe(
      "/custom/runtime",
    );
  });

  it("expands a tilde QWEN_RUNTIME_DIR", () => {
    expect(resolveRuntimeBaseDir(base({ env: { QWEN_RUNTIME_DIR: "~/rt" } }))).toBe(
      path.join(os.homedir(), "rt"),
    );
  });

  it("resolves a relative QWEN_RUNTIME_DIR against cwd", () => {
    expect(resolveRuntimeBaseDir(base({ env: { QWEN_RUNTIME_DIR: "rt" }, cwd: "/c" }))).toBe("/c/rt");
  });

  it("ignores a whitespace-only QWEN_RUNTIME_DIR and falls through", () => {
    expect(resolveRuntimeBaseDir(base({ env: { QWEN_RUNTIME_DIR: "   " } }))).toBe("/home/user/.qwen");
  });

  it("uses the runtimeOutputDir setting when no env var", () => {
    expect(resolveRuntimeBaseDir(base({ runtimeOutputDirSetting: "/setting/dir" }))).toBe(
      "/setting/dir",
    );
  });

  it("expands a relative runtimeOutputDir setting against cwd", () => {
    expect(resolveRuntimeBaseDir(base({ runtimeOutputDirSetting: "rel", cwd: "/c" }))).toBe("/c/rel");
  });

  it("falls back to cliConfigDir when nothing is set", () => {
    expect(resolveRuntimeBaseDir(base({}))).toBe("/home/user/.qwen");
  });
});

// The whole point of sharing this resolver: a single-thread transcript read (cwd known)
// and a global stats scan (no cwd) must resolve the SAME base for the same env+config, so
// the two readers can never silently diverge again.
describe("transcript ↔ stats base agreement", () => {
  it("resolves the same base whether or not a cwd is supplied (no override set)", () => {
    const withCwd = resolveRuntimeBaseDir({ env: {}, cliConfigDir: "/home/user/.qwen", cwd: "/work" });
    const withoutCwd = resolveRuntimeBaseDir({ env: {}, cliConfigDir: "/home/user/.qwen" });
    expect(withCwd).toBe(withoutCwd);
    expect(withoutCwd).toBe("/home/user/.qwen");
  });

  it("honors an absolute QWEN_RUNTIME_DIR identically with and without cwd", () => {
    const env = { QWEN_RUNTIME_DIR: "/custom/runtime" };
    const withCwd = resolveRuntimeBaseDir({ env, cliConfigDir: "/home/user/.qwen", cwd: "/work" });
    const withoutCwd = resolveRuntimeBaseDir({ env, cliConfigDir: "/home/user/.qwen" });
    expect(withCwd).toBe(withoutCwd);
    expect(withoutCwd).toBe("/custom/runtime");
  });
});
