// ru-code: coverage for buildQwenAcpSpawnInput — assembles the
// `node <cliJs> [launchArgs] [--allowed-mcp-server-names …] --acp` spawn plus
// the env overlay (NODE_TLS_REJECT_UNAUTHORIZED / settings overlay).
// makeQwenAcpRuntime spawns a real child + builds the ACP client → deferred to
// the Phase 3 fake-ACP e2e suite.
import { describe, expect, it } from "vite-plus/test";

import { NO_MCP_SERVER_SENTINEL } from "@ru-code/qwen/constants";

import { buildAllowedMcpServerArgs, buildQwenAcpSpawnInput } from "../../qwen/QwenAcpSupport.ts";

describe("buildQwenAcpSpawnInput", () => {
  it("builds `node <cliJs> --acp` with the TLS-off env by default", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work");
    expect(spawn.command).toBe(process.execPath);
    // ru-code: with the MCP engine on, OUR engine owns which servers qwen may connect —
    // no overlay means none, expressed by the sentinel (a missing flag would mean "no
    // filter", i.e. connect everything the user configured).
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);
    expect(spawn.cwd).toBe("/work");
    // ACP_SERVER_NO_SSL === true ⇒ this env key is always present.
    expect(spawn.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    expect(spawn.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });

  // ru-code (warm engine R0): qwen's relaunch wrapper must be disabled on EVERY
  // ACP spawn, unconditionally (not behind ACP_WARM_ENGINE) — one process, so
  // teardown signals hit the real agent, not a wrapper.
  it("always disables qwen's self-relaunch wrapper (QWEN_CODE_NO_RELAUNCH)", () => {
    const bare = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work");
    expect(bare.env?.QWEN_CODE_NO_RELAUNCH).toBe("true");

    // Present regardless of overlay/allowlist/environment composition.
    const composed = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "--verbose", homePath: "/home/me/.qwen" },
      "/work",
      { MY_VAR: "42" },
      { settingsOverlayPath: "/tmp/overlay.json", allowedMcpServers: ["alpha"] },
    );
    expect(composed.env?.QWEN_CODE_NO_RELAUNCH).toBe("true");
    // A caller-provided value must not override the hard-off.
    const attemptedOverride = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", {
      QWEN_CODE_NO_RELAUNCH: "false",
    });
    expect(attemptedOverride.env?.QWEN_CODE_NO_RELAUNCH).toBe("true");
  });

  it("splits launchArgs on whitespace and inserts them before --acp", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "--foo   --bar\tbaz", homePath: "" },
      "/work",
    );
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--foo",
      "--bar",
      "baz",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);
  });

  it("ignores a whitespace-only launchArgs and a whitespace-only homePath", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "   ", homePath: "   " },
      "/work",
    );
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);
  });

  it("merges the caller environment into the spawn env", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", { MY_VAR: "42" });
    expect(spawn.env?.MY_VAR).toBe("42");
    expect(spawn.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
  });

  it("threads a settings-overlay path into QWEN_CODE_SYSTEM_SETTINGS_PATH", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", undefined, {
      settingsOverlayPath: "/tmp/overlay.json",
    });
    expect(spawn.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe("/tmp/overlay.json");
  });

  // ru-code: the CLI decides by the PRESENCE of the flag — without it there is no filter and it
  // connects (and awaits) every configured MCP server during startup, which is what starved warm
  // slots of their warmup budget. "No MCP" must therefore be an allowlist nothing can match.
  it("always passes --allowed-mcp-server-names, using the sentinel for an empty allowlist", () => {
    const withAllow = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", undefined, {
      allowedMcpServers: ["alpha", "beta"],
    });
    expect(withAllow.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      "alpha,beta",
      "--acp",
    ]);

    const emptyAllow = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", undefined, {
      allowedMcpServers: [],
    });
    expect(emptyAllow.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);

    // An overlay path without an allowlist is the generic warm slot's exact shape.
    const overlayOnly = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", undefined, {
      settingsOverlayPath: "/tmp/overlay.json",
    });
    expect(overlayOnly.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);
  });

  it("ignores blank allowlist entries rather than passing them to the CLI", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work", undefined, {
      allowedMcpServers: ["  ", ""],
    });
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--allowed-mcp-server-names",
      NO_MCP_SERVER_SENTINEL,
      "--acp",
    ]);
  });

  describe("buildAllowedMcpServerArgs", () => {
    it("returns the sentinel for an absent or empty list, and the names otherwise", () => {
      expect(buildAllowedMcpServerArgs(undefined)).toEqual([
        "--allowed-mcp-server-names",
        NO_MCP_SERVER_SENTINEL,
      ]);
      expect(buildAllowedMcpServerArgs([])).toEqual([
        "--allowed-mcp-server-names",
        NO_MCP_SERVER_SENTINEL,
      ]);
      expect(buildAllowedMcpServerArgs(["alpha"])).toEqual(["--allowed-mcp-server-names", "alpha"]);
    });

    it("uses a sentinel no real server name can collide with", () => {
      expect(NO_MCP_SERVER_SENTINEL.length).toBeGreaterThan(0);
      expect(NO_MCP_SERVER_SENTINEL.trim()).toBe(NO_MCP_SERVER_SENTINEL);
      expect(NO_MCP_SERVER_SENTINEL).toMatch(/^__.*__$/);
    });
  });

  it("orders launchArgs before the allowlist before --acp", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "--verbose", homePath: "" },
      "/work",
      undefined,
      { allowedMcpServers: ["only"] },
    );
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--verbose",
      "--allowed-mcp-server-names",
      "only",
      "--acp",
    ]);
  });
});
