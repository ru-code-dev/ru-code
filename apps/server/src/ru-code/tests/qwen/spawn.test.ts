// ru-code: coverage for buildCliSpawn — the spawn shapes. A `.js` entry runs via
// the app's own interpreter (`node <cli.js> <args…>`); a `.cmd`/`.bat` entry (with
// CLI_INVOKE_AUTO) runs via `cmd.exe /d /s /c`; anything else (a bare command like
// `qwen`, or a native binary path) runs directly. All NEVER request a shell (kills
// the Windows shell:true / DEP0190 path).
import { describe, expect, it } from "vite-plus/test";

import { buildCliSpawn, isBatchEntry, isJsEntry, isTsEntry } from "@ru-code/qwen/spawn";

describe("isJsEntry", () => {
  it("recognizes .js/.mjs/.cjs (case-insensitive, trimmed)", () => {
    expect(isJsEntry("/opt/cli.js")).toBe(true);
    expect(isJsEntry("/opt/cli.mjs")).toBe(true);
    expect(isJsEntry("/opt/cli.cjs")).toBe(true);
    expect(isJsEntry("  /opt/cli.JS  ")).toBe(true);
  });
  it("rejects bare commands, native binaries, and .ts entries", () => {
    expect(isJsEntry("qwen")).toBe(false);
    expect(isJsEntry("/usr/local/bin/qwen")).toBe(false);
    expect(isJsEntry("/opt/cli.jsx")).toBe(false);
    expect(isJsEntry("/opt/fake-acp-server.ts")).toBe(false);
  });
});

describe("isTsEntry", () => {
  it("recognizes .ts/.mts/.cts (case-insensitive, trimmed)", () => {
    expect(isTsEntry("/opt/fake-acp-server.ts")).toBe(true);
    expect(isTsEntry("/opt/x.mts")).toBe(true);
    expect(isTsEntry("/opt/x.cts")).toBe(true);
    expect(isTsEntry("  /opt/X.TS  ")).toBe(true);
  });
  it("rejects .js entries, .tsx, and bare commands", () => {
    expect(isTsEntry("/opt/cli.js")).toBe(false);
    expect(isTsEntry("/opt/x.tsx")).toBe(false);
    expect(isTsEntry("qwen")).toBe(false);
  });
});

describe("buildCliSpawn — node mode (.js entry)", () => {
  it("spawns process.execPath with cliJs prepended and shell:false", () => {
    const spawn = buildCliSpawn("/opt/cli.js", ["--acp"]);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/opt/cli.js", "--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("preserves arg order and duplicates", () => {
    const spawn = buildCliSpawn("/opt/cli.js", ["--foo", "bar", "--foo"]);
    expect(spawn.args).toEqual(["/opt/cli.js", "--foo", "bar", "--foo"]);
  });

  it("handles an empty args list (just cliJs)", () => {
    const spawn = buildCliSpawn("/opt/cli.js", []);
    expect(spawn.args).toEqual(["/opt/cli.js"]);
  });
});

describe("buildCliSpawn — node mode (.ts entry, dev-only fake)", () => {
  it("spawns process.execPath with --experimental-strip-types before the .ts entry", () => {
    const spawn = buildCliSpawn("/opt/fake-acp-server.ts", ["--acp"]);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["--experimental-strip-types", "/opt/fake-acp-server.ts", "--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("trims a whitespaced .ts entry (spawned command matches classification)", () => {
    const spawn = buildCliSpawn("  /opt/fake-acp-server.ts\n", ["--acp"]);
    expect(spawn.args).toEqual(["--experimental-strip-types", "/opt/fake-acp-server.ts", "--acp"]);
  });
});

describe("isBatchEntry", () => {
  it("recognizes .cmd/.bat (case-insensitive, trimmed)", () => {
    expect(isBatchEntry("C:/Users/x/.qwen/bin/cli.cmd")).toBe(true);
    expect(isBatchEntry("C:\\Users\\x\\cli.BAT")).toBe(true);
    expect(isBatchEntry("  C:/x/cli.CMD  ")).toBe(true);
  });
  it("rejects .js entries, bare commands, and lookalike suffixes", () => {
    expect(isBatchEntry("/opt/cli.js")).toBe(false);
    expect(isBatchEntry("qwen")).toBe(false);
    expect(isBatchEntry("/opt/cli.cmdx")).toBe(false);
  });
});

describe("buildCliSpawn — batch mode (.cmd/.bat, CLI_INVOKE_AUTO)", () => {
  // Batch files are not real executables: a direct spawn throws EINVAL under Node's
  // post-CVE-2024-27980 hardening, so the dispatcher routes them through cmd.exe —
  // the same `/d /s /c` pattern as platform-compat externalOpenWindows, shell:false.
  it("routes a .cmd through cmd.exe /d /s /c with the bin prepended", () => {
    const spawn = buildCliSpawn("C:/Users/x/.qwen/bin/cli.cmd", ["--acp"], true);
    expect(spawn.command).toBe("cmd.exe");
    expect(spawn.args).toEqual(["/d", "/s", "/c", "C:/Users/x/.qwen/bin/cli.cmd", "--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("routes a .bat with spaces in the path the same way (args stay an array)", () => {
    const spawn = buildCliSpawn("C:/Program Files/x/cli.bat", ["-p", "test"], true);
    expect(spawn.command).toBe("cmd.exe");
    expect(spawn.args).toEqual(["/d", "/s", "/c", "C:/Program Files/x/cli.bat", "-p", "test"]);
  });

  // The flag-off contract: with CLI_INVOKE_AUTO=false every input keeps the historic
  // js/ts/direct split — a .cmd falls into the direct branch exactly as before the flag existed.
  it("with the flag off, a .cmd keeps today's direct shape", () => {
    const spawn = buildCliSpawn("C:/Users/x/cli.cmd", ["--acp"], false);
    expect(spawn.command).toBe("C:/Users/x/cli.cmd");
    expect(spawn.args).toEqual(["--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("the flag does not disturb .js (node) or bare-command (direct) inputs", () => {
    for (const auto of [true, false]) {
      expect(buildCliSpawn("/opt/cli.js", ["--acp"], auto).command).toBe(process.execPath);
      expect(buildCliSpawn("qwen", ["--acp"], auto).command).toBe("qwen");
    }
  });
});

describe("buildCliSpawn — direct mode (non-.js bin)", () => {
  it("runs a bare command directly (no node wrapper, shell:false)", () => {
    const spawn = buildCliSpawn("qwen", ["--acp"]);
    expect(spawn.command).toBe("qwen");
    expect(spawn.args).toEqual(["--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("runs a native-binary path directly", () => {
    const spawn = buildCliSpawn("/usr/local/bin/qwen", ["--version"]);
    expect(spawn.command).toBe("/usr/local/bin/qwen");
    expect(spawn.args).toEqual(["--version"]);
    expect(spawn.shell).toBe(false);
  });
});

describe("buildCliSpawn — trims surrounding whitespace on the bin", () => {
  it("trims a whitespaced .js entry (spawned command matches classification)", () => {
    const spawn = buildCliSpawn("  /opt/cli.js\n", ["--acp"]);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/opt/cli.js", "--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("trims a whitespaced bare command", () => {
    const spawn = buildCliSpawn(" qwen ", ["--acp"]);
    expect(spawn.command).toBe("qwen");
    expect(spawn.args).toEqual(["--acp"]);
    expect(spawn.shell).toBe(false);
  });
});
