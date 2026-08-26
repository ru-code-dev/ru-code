// @effect-diagnostics nodeBuiltinImport:off
// ru-code: the CLI warm-up. When qwen's bin is present (CLI_JS) but its profile dir (CONFIG_DIR) was
// never created, the installer fires qwen once during phase_checks — best-effort, NON-FATAL, and
// LOG-ONLY (nothing new on screen). It creates the profile before COMMIT so the app never spawns a
// cold qwen. All checks are black-box against the real bash installer, fully sandboxed.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { CLI_ENV, IDENTITY_KEY, cliArgAssignments } from "@ru-code/branding";

import {
  makeSandbox,
  readLog,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
} from "./harness.ts";
import type { Sandbox } from "./harness.ts";

// ru-code: the warm-up must hand the CLI its profile dir through the branding CLI registry, the
// same way every in-app spawn does — the installer's own `CONFIG_DIR` is not something the CLI
// reads. The stub below therefore takes its mkdir target from the registry's HOME var, so a
// warm-up that forgets the injection creates NOTHING and the first case fails.
const CLI_HOME_NAMES = CLI_ENV.HOME.names;
/** Where the stub records its argv, so the shared-flag assertions can read it. */
const ARGV_LOG = "warm-argv.log";

/**
 * A node stub standing in for qwen's cli.js. On a `-p` run it appends its argv to $WARM_ARGV_LOG
 * and creates its profile dir — read from the registry's CLI home var, or from $WARM_RELOCATE when
 * the case simulates the CLI writing somewhere else. $WARM_HANG/$WARM_FAIL redirect it.
 */
function writeWarmStub(sb: Sandbox): string {
  const stub =
    `const fs = require("node:fs");\n` +
    `const names = ${JSON.stringify([...CLI_HOME_NAMES])};\n` +
    `if (process.env.WARM_ARGV_LOG) {\n` +
    `  fs.appendFileSync(process.env.WARM_ARGV_LOG, process.argv.slice(2).join(" ") + "\\n");\n` +
    // ru-code: record whether the identity var (CLI_PASS_IDENTITY) reached the spawn — the name
    // comes from the registry, and "absent" must stay distinguishable from an empty value.
    `  const idKey = ${JSON.stringify(IDENTITY_KEY)};\n` +
    `  const idVal = idKey in process.env ? process.env[idKey] : "<absent>";\n` +
    `  fs.appendFileSync(process.env.WARM_ARGV_LOG, "identity=" + idVal + "\\n");\n` +
    `}\n` +
    `if (process.env.WARM_HANG === "1") { setInterval(() => {}, 1000); return; }\n` +
    `const home = names.map((n) => process.env[n]).find((v) => v);\n` +
    `const target = process.env.WARM_RELOCATE || home;\n` +
    `if (process.argv.includes("-p") && target) {\n` +
    `  fs.mkdirSync(target, { recursive: true });\n` +
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

      const argvLog = sb.path(ARGV_LOG);
      const r = runInstaller(sb, { preflight, env: { WARM_ARGV_LOG: argvLog } });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      // The stub only had the profile path because the warm-up injected the registry's home var.
      expect(NodeFS.existsSync(configDir)).toBe(true);
      // ru-code: a warm-up is a one-shot run with no use for MCP — it carries the registry's
      // shared flags exactly like every in-app spawn, so it cannot stall on slow MCP servers.
      const argv = NodeFS.readFileSync(argvLog, "utf8");
      expect(argv).toContain(cliArgAssignments().join(" "));
      expect(argv).toContain("-p");
      // No CLI_IDENTITY from the preflight ⇒ the variable is OMITTED, never written blank.
      expect(argv).toContain("identity=<absent>");
      const log = readLog(sb);
      expect(log).toContain("warm-up: run");
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

      const r = runInstaller(sb, { preflight, env: { WARM_RELOCATE: configDirAlt } });

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

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(readLog(sb)).not.toContain("warm-up: run");
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
      expect(readLog(sb)).not.toContain("warm-up: run");
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
        env: { INSTALL_PERFORM_CLI_WARM_UP: "false" },
      });

      expect(r.status).toBe(0);
      expect(NodeFS.existsSync(configDir)).toBe(false); // never fired
      expect(readLog(sb)).not.toContain("warm-up: run");
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

      const r = runInstaller(sb, { preflight, env: { WARM_FAIL: "1" } });

      expect(r.status).toBe(0); // warm-up failure never blocks the install
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(readLog(sb)).toContain("warm-up: run");
    } finally {
      sb.cleanup();
    }
  });

  // ru-code: CLI_PASS_IDENTITY — the preflight's CLI_IDENTITY value must reach the warm-up CHILD
  // as the registry-baked env var (exported only when non-empty; the absent case is pinned in the
  // first test via identity=<absent>).
  it("exports the preflight-extracted identity value into the warm-up spawn", () => {
    const sb = makeSandbox();
    try {
      const cliJs = writeWarmStub(sb);
      const configDir = sb.path("home", ".qwen");
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        cliJs,
        configDir,
        cliIdentity: "id-from-preflight",
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const argvLog = sb.path(ARGV_LOG);
      const r = runInstaller(sb, { preflight, env: { WARM_ARGV_LOG: argvLog } });

      expect(r.status).toBe(0);
      expect(NodeFS.readFileSync(argvLog, "utf8")).toContain("identity=id-from-preflight");
    } finally {
      sb.cleanup();
    }
  });

  // ru-code: CLI_INVOKE_AUTO — CLI_SPAWN_KIND=direct makes the warm-up run the bin ITSELF (shebang
  // script here). The historic node line would parse the sh text as JS and create nothing, so the
  // created profile proves the dispatch actually switched.
  it("runs a direct-kind bin itself (CLI_SPAWN_KIND=direct, sh shebang wrapper)", () => {
    const sb = makeSandbox();
    try {
      const homeVar = CLI_HOME_NAMES[0]!;
      const stub = NodePath.join(sb.root, "warm-cli.sh");
      NodeFS.writeFileSync(
        stub,
        `#!/bin/sh\n[ -n "\${WARM_ARGV_LOG:-}" ] && printf '%s\\n' "$*" >> "$WARM_ARGV_LOG"\n` +
          `[ -n "\${${homeVar}:-}" ] && mkdir -p "\$${homeVar}"\nexit 0\n`,
      );
      NodeFS.chmodSync(stub, 0o755);
      const configDir = sb.path("home", ".qwen");
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        cliJs: stub,
        cliSpawnKind: "direct",
        configDir,
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const argvLog = sb.path(ARGV_LOG);
      const r = runInstaller(sb, { preflight, env: { WARM_ARGV_LOG: argvLog } });

      expect(r.status).toBe(0);
      expect(NodeFS.existsSync(configDir)).toBe(true);
      expect(NodeFS.readFileSync(argvLog, "utf8")).toContain("-p");
      expect(readLog(sb)).toContain("warm-up: run [direct]");
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
        env: { WARM_HANG: "1", INSTALL_CLI_WARM_UP_TIMEOUT: "1" },
      });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(readLog(sb)).toContain("warm-up: run");
    } finally {
      sb.cleanup();
    }
  });
});
