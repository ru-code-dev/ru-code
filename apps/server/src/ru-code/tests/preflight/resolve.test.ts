// ru-code: CHARACTERIZATION tests for the ONE resolver `resolveQwenCli`. They lock the EXACT output
// formulas of INSTALLER/cli-resolution.md so the resolver can never silently drift from the behavior
// the installer + running app depend on. This file covers the non-Linux branches + cli.js detection
// with the REAL filesystem against a throwaway $HOME (Linux relocation is mocked in a sibling file,
// resolveLinuxReloc.test.ts, because it hinges on /home/<safe>/<user> existing).
//
// It NEVER fails: `ourRoot` (app home) and `configDir` (qwen profile dir) always resolve from the
// parent rules — the CLI profile is NOT required to exist; `cliJs` is the qwen bin found by probing
// the per-platform config paths (CLI_BIN_PATHS), or "" when qwen isn't installed.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP_HOME_DIRNAME, PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

import { CLI_BIN_PATHS } from "../../preflight/paths.ts";
import { expand } from "../../preflight/common/expand.ts";
import { resolveQwenCli } from "../../preflight/common/resolve.ts";

let tempHome = "";
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-resolve-"));
  savedHome = process.env.HOME;
  process.env.HOME = tempHome; // os.homedir() honours $HOME on POSIX
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  NodeFS.rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveQwenCli — roots on mac/Windows (home parent, no relocation)", () => {
  it("darwin: ourRoot=H/APP_DIR, configDir=H/CLI_DIR, configDirAlt='', no legacyRoot", () => {
    const r = resolveQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(r.ourRoot).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
    expect(r.configDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
    expect(r.configDirAlt).toBe(""); // off-Linux → no alternative candidate
    expect(r.legacyRoot).toBeUndefined();
    // the profile dir does NOT exist on disk, yet it still resolves (never a failure)
    expect(NodeFS.existsSync(r.configDir)).toBe(false);
  });

  it("win32: uses os.homedir(), NOT env.HOME/env.USERPROFILE — the parity fix", () => {
    // os.homedir() === tempHome here (POSIX honours $HOME). Pass DIVERGENT env.HOME/USERPROFILE:
    // the resolver must ignore them and derive both roots from os.homedir() (=tempHome), or the
    // cli.js probe (expand's {home}=os.homedir()) and the roots would desync on Windows.
    const r = resolveQwenCli({
      platform: "win32",
      env: { HOME: "/divergent-home", USERPROFILE: "/divergent-profile" },
    });
    expect(r.ourRoot).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
    expect(r.configDir).toBe(NodePath.join(tempHome, PREFLIGHT_CLI_PROBE_DIRNAME));
    expect(r.ourRoot).not.toContain("divergent");
    expect(r.configDir).not.toContain("divergent");
  });
});

describe("resolveQwenCli — cli.js detection (independent of the config folder)", () => {
  it("no qwen installed → cliJs empty, cliDetected false, source 'none' (never a failure)", () => {
    const r = resolveQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(r.cliJs).toBe("");
    expect(r.cliDetected).toBe(false);
    expect(r.source).toBe("none");
  });

  it("detects qwen from a CLI_BIN_PATHS entry — WITHOUT the config dir existing", () => {
    // Plant a cli.js at the first darwin config path (resolved against the throwaway home).
    const target = expand(CLI_BIN_PATHS.darwin[0]!, { HOME: tempHome });
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, "process.stdout.write('9.9.9')");

    const r = resolveQwenCli({ platform: "darwin", env: { HOME: tempHome } });
    expect(r.cliJs).toBe(target);
    expect(r.cliDetected).toBe(true); // FILE FOUND is the whole gate — no profile-dir requirement
    expect(r.source).toBe("config-path");
    // proof of independence: cliDetected is true even though the profile dir is absent
    expect(NodeFS.existsSync(r.configDir)).toBe(false);
    // roots are unchanged by CLI presence
    expect(r.ourRoot).toBe(NodePath.join(tempHome, APP_HOME_DIRNAME));
  });
});
