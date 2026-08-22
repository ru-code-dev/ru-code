// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
// ru-code: rc-file mutation — clean_rc (strip our PATH lines + legacy marker, back up, skip on
// empty result) and add_path (write the three shell read-paths, creating missing files, MSYS form
// on Windows, non-fatal on a read-only rc). Plus the strip-then-readd dedup composition.

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval, type Sandbox } from "./harness.ts";

const rcGlobals = { OS: "linux", APP_DIR_NAME: ".ru-code", APP_BIN: "ru-code" };

describe("install clean_rc", () => {
  it("removes our PATH line and legacy marker, keeps the rest, and backs up", () => {
    const sb = makeSandbox();
    try {
      sb.write(
        "home/.bashrc",
        [
          `export PATH="$HOME/other/bin:$PATH"`,
          `# ru-code v1`,
          `export PATH="/foo/.ru-code/bin:$PATH"`,
          `alias ll='ls -la'`,
          "",
        ].join("\n"),
      );
      const r = sourceEval(sb, `clean_rc`, { globals: rcGlobals });
      expect(r.status).toBe(0);
      const rc = sb.read("home/.bashrc");
      expect(rc).not.toContain(".ru-code/bin");
      expect(rc).not.toContain("# ru-code v1");
      expect(rc).toContain("other/bin");
      expect(rc).toContain("alias ll=");
      expect(sb.exists("home/.bashrc.bak")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  // CONTRACT CHANGE (PATH-persistence rework): the scrub removes our CHARACTERS, so an rc whose only
  // content is our line necessarily ends up empty — and it should. Such a file is one `add_path`
  // created itself, and the old "refuse to write an empty result" guard is what left a dead PATH
  // entry behind after uninstall, pointing at a directory that no longer exists. Nothing is risked:
  // the original is copied to `<rc>.bak` first. See SPECS/todo/add path-problems.md.
  it("fully cleans an rc whose only content is our line (backup kept)", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `export PATH="/foo/.ru-code/bin:$PATH"\n`);
      const r = sourceEval(sb, `clean_rc`, { globals: rcGlobals });
      expect(r.status).toBe(0);
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin");
      expect(sb.read("home/.bashrc")).toBe("");
      // The pre-scrub content is recoverable, so emptying the file is never data loss.
      expect(sb.exists("home/.bashrc.bak")).toBe(true);
      expect(sb.read("home/.bashrc.bak")).toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("no-ops when APP_DIR_NAME is empty", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `export PATH="/foo/.ru-code/bin:$PATH"\n`);
      const r = sourceEval(sb, `clean_rc`, { globals: { ...rcGlobals, APP_DIR_NAME: "" } });
      expect(r.status).toBe(0);
      expect(sb.read("home/.bashrc")).toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install add_path", () => {
  // Absolute LOGFILE inside the sandbox home so log() records land where we can read them
  // (globals are single-quoted — no $HOME expansion — so we pass concrete paths).
  const addPathGlobals = (sb: Sandbox, extra: Record<string, string>) => ({
    APP_DIR_NAME: ".ru-code",
    LOGFILE: sb.path("home/add_path.log"),
    ...extra,
  });

  it("writes the PATH export into .bashrc of an existing rc", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", "# my shell\n");
      const r = sourceEval(sb, `add_path`, {
        globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }),
      });
      expect(r.status).toBe(0);
      expect(sb.read("home/.bashrc")).toContain(`export PATH="/foo/.ru-code/bin:$PATH"`);
    } finally {
      sb.cleanup();
    }
  });

  it("creates .profile (NOT .bash_profile) as the login file when none exist", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `add_path`, {
        globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }),
        env: { SHELL: "/bin/bash" },
      });
      expect(r.status).toBe(0);
      expect(sb.exists("home/.profile")).toBe(true);
      expect(sb.exists("home/.bash_profile")).toBe(false);
      expect(sb.read("home/.profile")).toContain("/foo/.ru-code/bin");
      // .bashrc and .zshrc are created too — all three read-paths covered
      expect(sb.read("home/.bashrc")).toContain("/foo/.ru-code/bin");
      expect(sb.read("home/.zshrc")).toContain("/foo/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("uses MSYS drive form on Windows", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", "# shell\n");
      const r = sourceEval(sb, `add_path`, {
        globals: addPathGlobals(sb, { OS: "windows", BIN_DIR: "C:/apps/.ru-code/bin" }),
      });
      expect(r.status).toBe(0);
      expect(sb.read("home/.bashrc")).toContain("/c/apps/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("also writes $ZDOTDIR/.zshrc when ZDOTDIR points elsewhere", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `add_path`, {
        globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }),
        env: { ZDOTDIR: sb.path("home/zdot") },
      });
      expect(r.status).toBe(0);
      expect(sb.read("home/.zshrc")).toContain("/foo/.ru-code/bin");
      expect(sb.read("home/zdot/.zshrc")).toContain("/foo/.ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("is idempotent — a second add_path adds no duplicate line", () => {
    const sb = makeSandbox();
    try {
      const g = { globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }) };
      sourceEval(sb, `add_path`, g);
      const r = sourceEval(sb, `add_path`, g);
      expect(r.status).toBe(0);
      const count = sb
        .read("home/.bashrc")
        .split("\n")
        .filter((l) => l.includes(".ru-code/bin")).length;
      expect(count).toBe(1);
    } finally {
      sb.cleanup();
    }
  });

  it("read-only .bashrc is non-fatal — PATH still persists to .profile/.zshrc, RC=0", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", "# shell\n", 0o444);
      const r = sourceEval(sb, `add_path; echo "RC=$?"`, {
        globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }),
      });
      // A single read-only rc no longer blocks PATH — other targets carry it. RC stays 0.
      expect(r.stdout).toContain("RC=0");
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin"); // never written
      expect(sb.read("home/.profile")).toContain(".ru-code/bin"); // writable fallback
      // the skip is recorded in the LOG, not on screen
      expect(sb.read("home/add_path.log")).toContain("НЕТ ПРАВ на запись");
    } finally {
      sb.cleanup();
    }
  });

  it("returns RC=1 (→ ⚠ path note) only when NO target can be written", () => {
    const sb = makeSandbox();
    try {
      // Make $HOME itself unwritable so every create/append fails.
      sb.write("home/.bashrc", "# shell\n", 0o444);
      sb.write("home/.profile", "# p\n", 0o444);
      sb.write("home/.zshrc", "# z\n", 0o444);
      NodeFS.chmodSync(sb.home, 0o555);
      const r = sourceEval(sb, `add_path; echo "RC=$?"`, {
        globals: addPathGlobals(sb, { OS: "linux", BIN_DIR: "/foo/.ru-code/bin" }),
      });
      NodeFS.chmodSync(sb.home, 0o755); // restore so cleanup can remove
      expect(r.stdout).toContain("RC=1");
      expect(r.all).toContain("Не удалось записать PATH");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install clean_rc + add_path (dedup composition)", () => {
  it("leaves exactly one of our PATH lines after a re-run", () => {
    const sb = makeSandbox();
    try {
      sb.write("home/.bashrc", `export PATH="/old/.ru-code/bin:$PATH"\n# keep\n`);
      const r = sourceEval(sb, `clean_rc; add_path`, {
        globals: { ...rcGlobals, BIN_DIR: "/foo/.ru-code/bin" },
      });
      expect(r.status).toBe(0);
      const rc = sb.read("home/.bashrc");
      const count = rc.split("\n").filter((line) => line.includes(".ru-code/bin")).length;
      expect(count).toBe(1);
      expect(rc).toContain("/foo/.ru-code/bin");
      expect(rc).not.toContain("/old/.ru-code/bin");
      expect(rc).toContain("# keep");
    } finally {
      sb.cleanup();
    }
  });
});
