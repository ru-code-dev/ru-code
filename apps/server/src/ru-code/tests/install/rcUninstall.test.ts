// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
//
// ru-code: uninstall against the rc shapes the PATH rework introduced, driven through the REAL
// `install --uninstall` flow rather than the isolated functions.
//
// This path mattered more than it looked: `clean_rc` is shared by install and uninstall, so before
// the rework a user whose rc had a glued line lost their own content on `--uninstall` too — and a rc
// file the installer had CREATED itself (containing nothing but our line) was never cleaned at all,
// leaving a dead PATH entry pointing at a directory that no longer exists.
//
// Companion suites: rcLaws.test.ts (the law sweep) and rcEquivalence.test.ts (the differential proof
// that install-side behavior did not regress). Background: SPECS/todo/add path-problems.md.

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

/** An installed tree plus the bundle+preflight `--uninstall` needs to resolve paths. */
function seedInstalled(sb: Sandbox): string {
  sb.write("app/.ru-code/bin/cli.js", "process.exit(0);\n");
  sb.write("app/.ru-code/bin/.version", "1\n");
  writeFakeRelease(sb);
  return writeFakePreflight(sb, { ourRoot: sb.appRoot, appBin: "ru-code", nodeOk: "1" });
}

const uninstall = (sb: Sandbox, preflight: string) =>
  runInstaller(sb, { preflight, args: ["--uninstall", "--keep-source"] });

describe("uninstall scrubs the rc without collateral damage", () => {
  it("a glued line keeps the user's own content and loses only ours", () => {
    const sb = makeSandbox();
    try {
      const preflight = seedInstalled(sb);
      const ourLine = `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`;
      // The field-failure shape: a previous install appended onto a line with no trailing newline.
      sb.write("home/.bashrc", `alias ll='ls -la'${ourLine}\nexport EDITOR=vim\n`);

      const r = uninstall(sb, preflight);

      expect(r.status).toBe(0);
      const rc = sb.read("home/.bashrc");
      expect(rc).not.toContain(".ru-code/bin");
      expect(rc, "the user's alias must survive uninstall").toContain("alias ll='ls -la'");
      expect(rc).toContain("export EDITOR=vim");
    } finally {
      sb.cleanup();
    }
  });

  it("an rc that held ONLY our line is fully cleaned, leaving no orphaned PATH entry", () => {
    const sb = makeSandbox();
    try {
      const preflight = seedInstalled(sb);
      // Exactly what add_path leaves behind in a .zshrc it created itself.
      sb.write("home/.zshrc", `\nexport PATH="${sb.path("app/.ru-code/bin")}:$PATH"\n`);

      const r = uninstall(sb, preflight);

      expect(r.status).toBe(0);
      expect(sb.read("home/.zshrc")).not.toContain(".ru-code/bin");
    } finally {
      sb.cleanup();
    }
  });

  it("scrubs every shell file the writer can touch, in one run", () => {
    const sb = makeSandbox();
    try {
      const preflight = seedInstalled(sb);
      const ourLine = `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`;
      for (const rc of [".bashrc", ".profile", ".zshrc", ".bash_profile"]) {
        sb.write(`home/${rc}`, `# ${rc}\n${ourLine}\n`);
      }

      const r = uninstall(sb, preflight);

      expect(r.status).toBe(0);
      for (const rc of [".bashrc", ".profile", ".zshrc", ".bash_profile"]) {
        expect(sb.read(`home/${rc}`), `${rc} still carries our PATH line`).not.toContain(
          ".ru-code/bin",
        );
        expect(sb.read(`home/${rc}`)).toContain(`# ${rc}`);
      }
    } finally {
      sb.cleanup();
    }
  });

  it("a read-only rc is skipped with a warning, never fatal", () => {
    const sb = makeSandbox();
    try {
      const preflight = seedInstalled(sb);
      const ourLine = `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`;
      sb.write("home/.bashrc", `# keep\n${ourLine}\n`, 0o444);

      const r = uninstall(sb, preflight);

      // The install tree still goes away — an unwritable rc cannot block the uninstall.
      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
