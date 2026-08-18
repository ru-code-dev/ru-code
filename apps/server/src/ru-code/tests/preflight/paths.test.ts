// ru-code: covers the per-platform candidate path tables. CONFIG is always
// `{home}/<CLI_DIR>` on every platform; CLI_BIN_PATHS are optional fallback
// probes. We assert the token shapes and that they expand to concrete paths.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { expand } from "../../preflight/common/expand.ts";
import { CLI_BIN_PATHS, CONFIG } from "../../preflight/paths.ts";

const PLATFORMS = ["darwin", "linux", "win32"] as const;

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = "/home/tester";
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

describe("CONFIG", () => {
  it("has exactly one entry per platform, all `{home}/.qwen`", () => {
    for (const platform of PLATFORMS) {
      expect(CONFIG[platform], platform).toEqual(["{home}/.qwen"]);
    }
  });

  it("expands to <home>/.qwen", () => {
    const expanded = expand(CONFIG.linux[0]!);
    expect(expanded).toBe(NodePath.join(NodeOS.homedir(), ".qwen"));
  });
});

describe("CLI_BIN_PATHS", () => {
  it("lists at least one candidate per platform", () => {
    for (const platform of PLATFORMS) {
      expect(CLI_BIN_PATHS[platform].length, platform).toBeGreaterThan(0);
    }
  });

  it("every candidate points at a cli.js", () => {
    for (const platform of PLATFORMS) {
      for (const candidate of CLI_BIN_PATHS[platform]) {
        expect(candidate.endsWith("cli.js"), `${platform}: ${candidate}`).toBe(true);
      }
    }
  });

  it("darwin {home} candidate expands under the homedir", () => {
    const homeCandidate = CLI_BIN_PATHS.darwin.find((p) => p.startsWith("{home}"))!;
    const expanded = expand(homeCandidate);
    expect(expanded.startsWith(NodeOS.homedir())).toBe(true);
    expect(expanded).not.toContain("{home}");
    expect(expanded.endsWith("cli.js")).toBe(true);
  });

  it("win32 candidates use the {appdata}/{localappdata} tokens", () => {
    const joined = CLI_BIN_PATHS.win32.join("\n");
    expect(joined).toContain("{appdata}");
    expect(joined).toContain("{localappdata}");
  });
});
