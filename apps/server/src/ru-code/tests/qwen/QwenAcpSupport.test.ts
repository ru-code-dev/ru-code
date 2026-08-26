// ru-code: coverage for buildQwenAcpSpawnInput — assembles the
// `node <cliJs> [launchArgs] [allowlist flag …] --acp` spawn plus
// the env overlay (the branding CLI registry + NODE_TLS_REJECT_UNAUTHORIZED).
// makeQwenAcpRuntime spawns a real child + builds the ACP client → deferred to
// the Phase 3 fake-ACP e2e suite.
//
// Every expectation here is DERIVED from @ru-code/branding's registry (cliEnv.ts) — the concrete
// var names / flag values live there and in the one literal snapshot (cliEnvRegistry.test.ts),
// never in this file. That is what makes this a pin: an ACP spawn cannot drop a registry row.
import { describe, expect, it } from "vite-plus/test";

import { CLI_ENV, allowedMcpServerArgs, cliEnvAssignments } from "@ru-code/branding";

import { buildQwenAcpSpawnInput } from "../../qwen/QwenAcpSupport.ts";

// Absolute (no `~`), so the expected value is the runtime value verbatim; expansion is pinned
// separately in qwenSpawnRegistry.test.ts.
const HOME_DIR = "/home/me/.qwen";
const OVERLAY = "/tmp/overlay.json";

const SETTINGS_NAMES = CLI_ENV.SYSTEM_SETTINGS_PATH.names;

/** Every enforced pair a plain (no-overlay) ACP spawn must carry. */
const enforcedPairs = cliEnvAssignments({ HOME: HOME_DIR });

describe("buildQwenAcpSpawnInput", () => {
  it("builds `node <cliJs> --acp` with the TLS-off env by default", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work");
    expect(spawn.command).toBe(process.execPath);
    // ru-code: with the MCP engine on, OUR engine owns which servers qwen may connect —
    // no overlay means none, expressed by the registry's sentinel (a missing flag would mean
    // "no filter", i.e. connect everything the user configured).
    expect(spawn.args).toEqual(["/opt/cli.js", ...allowedMcpServerArgs(undefined), "--acp"]);
    expect(spawn.cwd).toBe("/work");
    // ACP_SERVER_NO_SSL === true ⇒ this env key is always present.
    expect(spawn.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
  });

  // ru-code: THE registry pin. Every row of CLI_ENV that applies to a plain ACP spawn must be
  // present under EVERY alias — this is what forbids a hand-rolled env line at this site.
  it("carries every enforced registry assignment, including the CLI home dir", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work");
    for (const [name, value] of enforcedPairs) {
      expect(spawn.env?.[name], `enforced ${name}`).toBe(value);
    }
    // The home dir is genuinely threaded (not merely "some pair exists").
    for (const name of CLI_ENV.HOME.names) {
      expect(spawn.env?.[name]).toBe(HOME_DIR);
    }
  });

  // ru-code (warm engine R0): qwen's relaunch wrapper must be disabled on EVERY ACP spawn,
  // unconditionally — one process, so teardown signals hit the real agent, not a wrapper.
  it("keeps the enforced assignments regardless of overlay/allowlist/environment composition", () => {
    const composed = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      HOME_DIR,
      { launchArgs: "--verbose" },
      "/work",
      { MY_VAR: "42" },
      { settingsOverlayPath: OVERLAY, allowedMcpServers: ["alpha"] },
    );
    for (const [name, value] of enforcedPairs) {
      expect(composed.env?.[name], `enforced ${name}`).toBe(value);
    }
    expect(composed.env?.MY_VAR).toBe("42");
  });

  // ru-code: the enforced vars are policy, so an inherited/per-instance value must not win.
  it("defeats an inherited environment that tries to override an enforced var", () => {
    const sabotage: NodeJS.ProcessEnv = {};
    for (const [name] of enforcedPairs) sabotage[name] = "sabotage";
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", sabotage);
    for (const [name, value] of enforcedPairs) {
      expect(spawn.env?.[name], `enforced ${name} beats the inherited value`).toBe(value);
    }
  });

  it("splits launchArgs on whitespace and inserts them before --acp", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      HOME_DIR,
      { launchArgs: "--foo   --bar\tbaz" },
      "/work",
    );
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--foo",
      "--bar",
      "baz",
      ...allowedMcpServerArgs(undefined),
      "--acp",
    ]);
  });

  it("ignores a whitespace-only launchArgs", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, { launchArgs: "   " }, "/work");
    expect(spawn.args).toEqual(["/opt/cli.js", ...allowedMcpServerArgs(undefined), "--acp"]);
  });

  it("merges the caller environment into the spawn env", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", { MY_VAR: "42" });
    expect(spawn.env?.MY_VAR).toBe("42");
    expect(spawn.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
  });

  it("threads a settings-overlay path into EVERY system-settings alias", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
      settingsOverlayPath: OVERLAY,
    });
    for (const name of SETTINGS_NAMES) {
      expect(spawn.env?.[name]).toBe(OVERLAY);
    }
  });

  // The runtime row is OPTIONAL: no overlay ⇒ the variable must be absent entirely, not blank.
  it("emits NO system-settings alias at all when there is no overlay", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work");
    for (const name of SETTINGS_NAMES) {
      expect(spawn.env?.[name], `${name} absent without an overlay`).toBeUndefined();
    }
  });

  // ru-code: the CLI decides by the PRESENCE of the flag — without it there is no filter and it
  // connects (and awaits) every configured MCP server during startup, which is what starved warm
  // slots of their warmup budget. "No MCP" must therefore be an allowlist nothing can match.
  it("always passes the allowlist flag, using the registry default for an empty allowlist", () => {
    const withAllow = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
      allowedMcpServers: ["alpha", "beta"],
    });
    expect(withAllow.args).toEqual([
      "/opt/cli.js",
      ...allowedMcpServerArgs(["alpha", "beta"]),
      "--acp",
    ]);

    const emptyAllow = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
      allowedMcpServers: [],
    });
    expect(emptyAllow.args).toEqual(["/opt/cli.js", ...allowedMcpServerArgs([]), "--acp"]);

    // An overlay path without an allowlist is the generic warm slot's exact shape.
    const overlayOnly = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
      settingsOverlayPath: OVERLAY,
    });
    expect(overlayOnly.args).toEqual(["/opt/cli.js", ...allowedMcpServerArgs(undefined), "--acp"]);
  });

  it("ignores blank allowlist entries rather than passing them to the CLI", () => {
    const spawn = buildQwenAcpSpawnInput("/opt/cli.js", HOME_DIR, null, "/work", undefined, {
      allowedMcpServers: ["  ", ""],
    });
    expect(spawn.args).toEqual(["/opt/cli.js", ...allowedMcpServerArgs(["  ", ""]), "--acp"]);
  });

  it("orders launchArgs before the allowlist before --acp", () => {
    const spawn = buildQwenAcpSpawnInput(
      "/opt/cli.js",
      HOME_DIR,
      { launchArgs: "--verbose" },
      "/work",
      undefined,
      { allowedMcpServers: ["only"] },
    );
    expect(spawn.args).toEqual([
      "/opt/cli.js",
      "--verbose",
      ...allowedMcpServerArgs(["only"]),
      "--acp",
    ]);
  });
});
