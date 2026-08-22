// ru-code: argument parsing — parse_args flag handling + the --help/usage path. White-box for the
// parsed state (DO_UNINSTALL / KEEP_SOURCE / INSTALL_DIR), black-box for the reject-bad-input and
// --help paths (which exit before anything destructive runs). `--local` was DROPPED (§0).

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, runInstaller, sourceEval } from "./harness.ts";

describe("install parse_args", () => {
  it("sets DO_UNINSTALL + KEEP_SOURCE from flags", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(
        sb,
        `parse_args --uninstall --keep-source; echo "U=$DO_UNINSTALL K=$KEEP_SOURCE"`,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("U=true K=true");
    } finally {
      sb.cleanup();
    }
  });

  it("captures --install-dir path", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `parse_args --install-dir /opt/ru; echo "D=$INSTALL_DIR"`);
      expect(r.stdout).toContain("D=/opt/ru");
    } finally {
      sb.cleanup();
    }
  });

  it("--local is no longer supported (rejected as an unknown flag)", () => {
    const sb = makeSandbox();
    try {
      const r = runInstaller(sb, { args: ["--local", "/tmp/x/pkg.tgz"] });
      expect(r.status).toBe(1); // BLOCKED_RECOMMENDATION
      expect(r.all).toContain("Не удалось разобрать параметры");
    } finally {
      sb.cleanup();
    }
  });

  it("rejects --install-dir with no argument (usage recommendation, exit 1)", () => {
    const sb = makeSandbox();
    try {
      const r = runInstaller(sb, { args: ["--install-dir"] });
      expect(r.status).toBe(1);
      expect(r.all).toContain("--help");
    } finally {
      sb.cleanup();
    }
  });

  it("rejects an unknown flag and points at --help (exit 1)", () => {
    const sb = makeSandbox();
    try {
      const r = runInstaller(sb, { args: ["--nope"] });
      expect(r.status).toBe(1);
      expect(r.all).toContain("Не удалось разобрать параметры");
      expect(r.all).toContain("--help");
    } finally {
      sb.cleanup();
    }
  });

  it("--help prints usage to stdout and exits 0", () => {
    const sb = makeSandbox();
    try {
      const r = runInstaller(sb, { args: ["--help"] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("--uninstall");
      expect(r.stdout).toContain("--help");
    } finally {
      sb.cleanup();
    }
  });
});
