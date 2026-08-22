// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the CLI warm-up. When qwen's bin is present (CLI_JS) but its profile dir (CONFIG_DIR) was
// never created, the installer fires qwen once during phase_checks — best-effort, NON-FATAL, and
// LOG-ONLY (nothing new on screen). It creates the profile before COMMIT so the app never spawns a
// cold qwen. All checks are black-box against the real bash installer, fully sandboxed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  readLog,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
} from "./harness.ts";
import type { Sandbox } from "./harness.ts";

/**
 * A node stub standing in for qwen's cli.js. On `-p test` it creates the dir named in $WARM_TARGET
 * (simulating qwen writing its profile), unless $WARM_HANG/$WARM_FAIL redirect it. Returns its path.
 */
function writeWarmStub(sb: Sandbox): string {
  const stub =
    `const fs = require("node:fs");\n` +
    `if (process.env.WARM_HANG === "1") { setInterval(() => {}, 1000); return; }\n` +
    `if (process.argv[2] === "-p" && process.env.WARM_TARGET) {\n` +
    `  fs.mkdirSync(process.env.WARM_TARGET, { recursive: true });\n` +
    `}\n` +
    `process.exit(process.env.WARM_FAIL === "1" ? 1 : 0);\n`;
  const target = NodePath.join(sb.root, "warm-cli.js");
  NodeFS.writeFileSync(target, stub);
  return target;
}

describe("install CLI warm-up", () => {
  it("fires when the bin is present but the profile dir is missing → creates it, logs it", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen"); // does NOT exist yet
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { WARM_TARGET: configDir } });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(NodeFS.existsSync(configDir)).toBe(true); // warm-up created the profile
      const log = readLog(sb);
      expect(log).toContain("warm-up: node");
      expect(log).toContain(`warm-up: profile created at ${configDir}`);
      // LOG-ONLY: no warm-up wording on the user-facing card
      expect(r.all).not.toContain("warm-up");
    } finally {
      sb.cleanup();
    }
  });

  it("re-checks CONFIG_DIR_ALT (Linux relocation) for where the profile landed", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen"); // primary — stays missing
      const configDirAlt = sb.path("work", ".qwen"); // qwen actually writes here
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        cliJs,
        configDir,
        configDirAlt,
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { WARM_TARGET: configDirAlt } });

      expect(r.status).toBe(0);
      const log = readLog(sb);
      expect(log).toContain(`warm-up: profile created at ${configDirAlt}`);
    } finally {
      sb.cleanup();
    }
  });

  it("skips when the profile dir already exists", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen");
      NodeFS.mkdirSync(configDir, { recursive: true }); // already present
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { WARM_TARGET: configDir } });

      expect(r.status).toBe(0);
      expect(readLog(sb)).not.toContain("warm-up: node");
    } finally {
      sb.cleanup();
    }
  });

  it("skips when no bin is detected (CLI_JS empty)", () => {
    const sb = makeSandbox();
    try {
      const configDir = sb.path("home", ".qwen"); // missing
      // no cliJs emitted → CLI_JS stays ""
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(readLog(sb)).not.toContain("warm-up: node");
    } finally {
      sb.cleanup();
    }
  });

  it("skips when INSTALL_PERFORM_CLI_WARM_UP=false", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen");
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, {
        preflight,
        env: { WARM_TARGET: configDir, INSTALL_PERFORM_CLI_WARM_UP: "false" },
      });

      expect(r.status).toBe(0);
      expect(NodeFS.existsSync(configDir)).toBe(false); // never fired
      expect(readLog(sb)).not.toContain("warm-up: node");
    } finally {
      sb.cleanup();
    }
  });

  it("is NON-FATAL when the bin exits non-zero (install still succeeds)", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen");
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { WARM_TARGET: configDir, WARM_FAIL: "1" } });

      expect(r.status).toBe(0); // warm-up failure never blocks the install
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(readLog(sb)).toContain("warm-up: node");
    } finally {
      sb.cleanup();
    }
  });

  it("is BOUNDED + non-fatal when the bin hangs (targeted bg-kill at the timeout)", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen");
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, cliJs, configDir });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      // WARM_HANG makes the stub never exit; a 1s timeout must bg-kill it and let the install finish
      // well within the harness's 60s cap (proving no unbounded wait, without a real 20s pause).
      const r = runInstaller(sb, {
        preflight,
        env: { WARM_TARGET: configDir, WARM_HANG: "1", INSTALL_CLI_WARM_UP_TIMEOUT: "1" },
      });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(readLog(sb)).toContain("warm-up: node");
    } finally {
      sb.cleanup();
    }
  });
});
