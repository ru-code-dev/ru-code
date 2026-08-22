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

import { expand } from "../../preflight/common/expand.ts";
import { CLI_BIN_PATHS } from "../../preflight/paths.ts";
import { resolveStartupQwenCli } from "../../startup/resolveStartupQwenCli.ts";

let tempHome = "";
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-startup-cli-"));
  savedHome = process.env.HOME;
  // os.homedir() reads $HOME first on POSIX — redirect every home lookup at the
  // throwaway dir (which has no CLI config) for the duration of the test.
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  NodeFS.rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveStartupQwenCli — base dir", () => {
  it("defaultBaseDir = resolver ourRoot (<home>/.ru-code) regardless of CLI presence", () => {
    // No qwen bin under the throwaway home → cliJs "" → defaultBaseDir still resolves to ourRoot.
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.defaultBaseDir).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });
});

describe("resolveStartupQwenCli — qwen CLI detection", () => {
  it("NOT detected (no install) → disabled, empty cliJs, home config fallback", () => {
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.cliDetected).toBe(false);
    // Empty cliJs is the gate that keeps the qwen provider disabled.
    expect(result.cliJs).toBe("");
    // configDir always resolves to join(home, PREFLIGHT_CLI_PROBE_DIRNAME).
    expect(result.cliConfigDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
  });

  it("detected ⇒ enabled, cliJs points at the found cli.js (per-platform config path)", () => {
    // qwen is found by probing CLI_BIN_PATHS — plant a cli.js at the first darwin entry.
    const target = expand(CLI_BIN_PATHS.darwin[0]!, { HOME: tempHome });
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, "// stub cli\n");
    const result = resolveStartupQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(result.cliDetected).toBe(true);
    expect(result.cliJs).toBe(target); // the gate that enables the qwen provider
    // config dir rides the parent (home here) regardless of where the bin lives
    expect(result.cliConfigDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
  });
});
