// ru-code: focused coverage of the pure `resolveQwenCli` state machine. The
// resolver reads the real filesystem via `node:fs`, so to stay deterministic we
// pin `os.homedir()` at an ISOLATED temp dir (homedir() honours $HOME on POSIX)
// and only assert the `ok:false` STOP shapes that are reachable without any real
// CLI install:
//   - config dir missing                       → MESSAGES.CONFIG_NOT_FOUND
//   - config present, no cli.js, fallback off   → MESSAGES.CLI_NOT_FOUND
// We never touch the developer's real ~/.qwen — each test owns a throwaway home.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { MESSAGES } from "../../preflight/common/messages.ts";
import { resolveQwenCli } from "../../preflight/common/resolve.ts";

const CONFIG_DIRNAME = ".qwen"; // CLI_DIR = PREFLIGHT_CLI_PROBE_DIRNAME = ".qwen"

let tempHome = "";
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-resolve-"));
  savedHome = process.env.HOME;
  // os.homedir() reads $HOME first on POSIX — this redirects every `{home}`
  // expansion at the throwaway dir for the duration of the test.
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

describe("resolveQwenCli — ok:false STOP shapes", () => {
  it("config dir missing → CONFIG_NOT_FOUND with probed paths", () => {
    // tempHome has no `.qwen` subdir → CONFIG[platformKey] never matches.
    const result = resolveQwenCli({ platform: "linux", env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(MESSAGES.CONFIG_NOT_FOUND);
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0]).toContain(CONFIG_DIRNAME);
  });

  it("config present, no cli.js, TRY_TO_FIND_CLI off → CLI_NOT_FOUND fallback STOP", () => {
    // Create only the config dir: no bin/cli.js, no .install-dir record.
    NodeFS.mkdirSync(NodePath.join(tempHome, CONFIG_DIRNAME), { recursive: true });
    const result = resolveQwenCli({ platform: "linux", env: {}, tryFindCli: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(MESSAGES.CLI_NOT_FOUND);
    // fallback off → the resolver STOPs with the disabled-flag breadcrumb.
    expect(result.details).toEqual(["TRY_TO_FIND_CLI выключен"]);
    expect(result.configDir).toBe(NodePath.join(tempHome, CONFIG_DIRNAME));
  });
});
