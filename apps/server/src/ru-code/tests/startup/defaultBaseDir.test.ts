// ru-code: covers the default base-dir seam. The installed app defaults its base
// dir to the resolver's ourRoot; when the CLI can't be located (dev/pre-install)
// it falls back to <home>/.ru-code. resolveCli reads the real filesystem via
// os.homedir() (honours $HOME on POSIX), so each test owns a throwaway $HOME.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP_HOME_DIRNAME } from "@ru-code/branding";

import { resolveDefaultBaseDir } from "../../startup/defaultBaseDir.ts";

let tempHome = "";
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-basedir-"));
  savedHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  NodeFS.rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveDefaultBaseDir", () => {
  it("falls back to <home>/.ru-code when the CLI cannot be located", () => {
    // No ~/.qwen config dir → resolveCli STOPs → fallback branch.
    const result = resolveDefaultBaseDir({ platform: "darwin", env: { HOME: tempHome } });
    expect(result).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });

  it("returns the resolver ourRoot for a standard install (config dir + bin/cli.js)", () => {
    // Standard layout: <home>/.qwen (config) + <home>/.qwen/bin/cli.js →
    // resolveCli succeeds, ourRoot = <home>/.ru-code.
    const binDir = NodePath.join(tempHome, ".qwen", "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(binDir, "cli.js"), "process.stdout.write('9.9.9')");
    const result = resolveDefaultBaseDir({ platform: "darwin", env: { HOME: tempHome } });
    expect(result).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });
});
