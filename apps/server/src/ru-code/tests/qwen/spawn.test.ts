// ru-code: coverage for buildCliSpawn — the two spawn shapes. A `.js` entry runs
// via the app's own interpreter (`node <cli.js> <args…>`); anything else (a bare
// command like `qwen`, or a native binary path) runs directly. Both NEVER request a
// shell (kills the Windows shell:true / DEP0190 path).
import { describe, expect, it } from "vite-plus/test";

import { buildCliSpawn, isJsEntry, isTsEntry } from "@ru-code/qwen/spawn";

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
