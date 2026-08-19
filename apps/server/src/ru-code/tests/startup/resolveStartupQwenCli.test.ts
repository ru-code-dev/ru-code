// ru-code: covers the ONE startup CLI resolution (resolveStartupQwenCli). A
// single preflight disk scan (resolveQwenCli) yields BOTH the default base dir
// (resolver ourRoot, else <home>/.ru-code) and the non-fatal qwen CLI detection
// (cliJs / cliConfigDir / cliDetected). resolveQwenCli reads the real filesystem
// via os.homedir() (honours $HOME on POSIX), so each test owns a throwaway $HOME
// with no CLI install and pins platform=darwin to skip Linux relocation.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP_HOME_DIRNAME, PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

import { resolveStartupQwenCli } from "../../startup/resolveStartupQwenCli.ts";

let tempHome = "";
let savedHome: string | undefined;
let savedTryFind: string | undefined;

beforeEach(() => {
  tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-startup-cli-"));
  savedHome = process.env.HOME;
  savedTryFind = process.env.TRY_TO_FIND_CLI;
  // os.homedir() reads $HOME first on POSIX — redirect every home lookup at the
  // throwaway dir (which has no CLI config) for the duration of the test.
  process.env.HOME = tempHome;
});

afterEach(() => {
  const restore = (key: "HOME" | "TRY_TO_FIND_CLI", value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore("HOME", savedHome);
  restore("TRY_TO_FIND_CLI", savedTryFind);
  NodeFS.rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveStartupQwenCli — base dir", () => {
  it("falls back to <home>/.ru-code when no CLI install is found", () => {
    // No ~/.qwen config dir → resolveQwenCli STOPs → fallback branch.
    const result = resolveStartupQwenCli({
      platform: "darwin",
      env: { HOME: tempHome, TRY_TO_FIND_CLI: "0" },
    });
    expect(result.defaultBaseDir).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });

  it("returns the resolver ourRoot for a standard install (config dir + bin/cli.js)", () => {
    const binDir = NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(binDir, "cli.js"), "process.stdout.write('9.9.9')");
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.defaultBaseDir).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });
});

describe("resolveStartupQwenCli — qwen CLI detection", () => {
  it("NOT detected (no install) → disabled, empty cliJs, home config fallback", () => {
    const result = resolveStartupQwenCli({
      platform: "darwin",
      env: { HOME: tempHome, TRY_TO_FIND_CLI: "0" },
    });
    expect(result.cliDetected).toBe(false);
    // Empty cliJs is the gate that keeps the qwen provider disabled.
    expect(result.cliJs).toBe("");
    // No config dir found ⇒ fallback is join(home, PREFLIGHT_CLI_PROBE_DIRNAME).
    expect(result.cliConfigDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
  });

  it("defaults tryFindCli on when TRY_TO_FIND_CLI is unset (still not detected here)", () => {
    // env without TRY_TO_FIND_CLI → tryFindCli defaults on; no real CLI under the
    // throwaway home, so detection still fails but a fallback config dir is produced.
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.cliDetected).toBe(false);
    expect(result.cliJs).toBe("");
    expect(result.cliConfigDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
  });

  it("detected ⇒ enabled, cliJs points at the found cli.js", () => {
    const binDir = NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(binDir, "cli.js"), "// stub cli\n");
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.cliDetected).toBe(true);
    expect(result.cliConfigDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
    // Non-empty cliJs is the gate that enables the qwen provider.
    expect(result.cliJs).toBe(
      NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME, "bin", "cli.js"),
    );
    expect(result.cliJs).not.toBe("");
  });
});
