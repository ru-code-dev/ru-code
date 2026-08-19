// ru-code: coverage for buildQwenAcpSpawnInput — assembles the
// `node <cliJs> [launchArgs] [--allowed-mcp-server-names …] --acp` spawn plus
// the env overlay (CLI_HOME / NODE_TLS_REJECT_UNAUTHORIZED / settings overlay).
// makeQwenAcpRuntime spawns a real child + builds the ACP client → deferred to
// the Phase 3 fake-ACP e2e suite.
import { describe, expect, it } from "vite-plus/test";

import { buildQwenAcpSpawnInput } from "../../qwen/QwenAcpSupport.ts";

describe("buildQwenAcpSpawnInput", () => {
  it("builds `node <cliJs> --acp` with the TLS-off env by default", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", null, "/work");
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/opt/cli.js", "--acp"]);
    expect(spawn.cwd).toBe("/work");
    // ACP_SERVER_NO_SSL === true ⇒ this env key is always present.
    expect(spawn.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    expect(spawn.env?.CLI_HOME).toBeUndefined();
    expect(spawn.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });

  it("splits launchArgs on whitespace and inserts them before --acp", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "--foo   --bar\tbaz", homePath: "" },
      "/work",
    );
    expect(spawn.args).toEqual(["/opt/cli.js", "--foo", "--bar", "baz", "--acp"]);
  });

  it("ignores a whitespace-only launchArgs and a whitespace-only homePath", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "   ", homePath: "   " },
      "/work",
    );
    expect(spawn.args).toEqual(["/opt/cli.js", "--acp"]);
    expect(spawn.env?.CLI_HOME).toBeUndefined();
  });

  it("sets CLI_HOME from a trimmed homePath", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      { launchArgs: "", homePath: "  /home/me/.qwen  " },
      "/work",
    );
    expect(spawn.env?.CLI_HOME).toBe("/home/me/.qwen");
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

  it("adds --allowed-mcp-server-names only when the allowlist is non-empty", () => {
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
    expect(emptyAllow.args).toEqual(["/opt/cli.js", "--acp"]);
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
