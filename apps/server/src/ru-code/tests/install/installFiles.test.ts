// ru-code: install_files (copy payload + write the last-written .version marker), create_wrapper
// (executable launcher that execs node on cli.js), and verify (runs cli.js --version; dies on
// failure). Driven off a real extracted fake release into a sandbox BIN_DIR.

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval, writeFakeRelease, type Sandbox } from "./harness.ts";

const EXTRACT_AND_INSTALL = `extract_archive\ninstall_files`;

function baseGlobals(sb: Sandbox, tarball: string): Record<string, string> {
  return {
    ARCHIVE_PATH: tarball,
    TEMP_DIR: sb.path("tmp"),
    BIN_DIR: sb.path("app/.ru-code/bin"),
    APP_BIN: "ru-code",
    NODE_PATH: process.execPath,
  };
}

describe("install install_files", () => {
  it("lands the whole bundle tree in bin/ and writes .version last", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `${EXTRACT_AND_INSTALL}\necho "V=$(cat "$BIN_DIR/.version")"`, {
        globals: baseGlobals(sb, tarball),
      });
      expect(r.status).toBe(0);
      // The launcher pair at the root of bin/ …
      expect(sb.read("app/.ru-code/bin/cli.js")).toContain("FROZEN launcher");
      expect(JSON.parse(sb.read("app/.ru-code/bin/current.json"))).toEqual({
        schema: 1,
        version: "1.0.0",
        entry: "versions/1.0.0/cli.js",
      });
      // The wrapper's module declaration travels with it: the copy is verbatim, and this is what
      // would notice if it ever became per-file again.
      expect(JSON.parse(sb.read("app/.ru-code/bin/package.json"))).toEqual({
        type: "module",
        private: true,
      });
      // … and the version payload underneath it.
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/cli.js")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/package.json")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/client")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/node_modules")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/versions/1.0.0/runtime.mjs")).toBe(true);
      // The install-time preflight is dropped; nothing else from the archive is.
      expect(sb.exists("app/.ru-code/bin/preflight.mjs")).toBe(false);
      expect(r.stdout).toContain("V=1");
    } finally {
      sb.cleanup();
    }
  });

  // A repair reinstall over a machine the updater already moved forward: bin/ is wiped first, so
  // exactly the bundle's own version remains — no orphan version dirs, no stale pointer.
  it("leaves exactly the bundle's version after a wipe + reinstall", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      sb.write("app/.ru-code/bin/versions/9.9.9/cli.js", "// left by an in-app update\n");
      sb.write("app/.ru-code/bin/current.json", `{"schema":1,"version":"9.9.9","entry":"x"}\n`);
      const r = sourceEval(sb, `remove_bin\n${EXTRACT_AND_INSTALL}\nls "$BIN_DIR/versions"`, {
        globals: { ...baseGlobals(sb, tarball), APP_DIR_NAME: ".ru-code" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("1.0.0");
      expect(sb.exists("app/.ru-code/bin/versions/9.9.9")).toBe(false);
      expect(JSON.parse(sb.read("app/.ru-code/bin/current.json")).version).toBe("1.0.0");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install create_wrapper", () => {
  it("writes an executable launcher that execs node on cli.js", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(
        sb,
        `${EXTRACT_AND_INSTALL}\ncreate_wrapper\n[ -x "$BIN_DIR/$APP_BIN" ] && echo EXEC\ncat "$BIN_DIR/$APP_BIN"`,
        { globals: baseGlobals(sb, tarball) },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("EXEC");
      expect(r.stdout).toContain("cli.js");
      expect(r.stdout).toContain("exec");
      // POSIX keeps the relocatable runtime form — the Windows branch below must never leak here.
      expect(r.stdout).toContain(`"$(dirname "$0")/cli.js"`);
    } finally {
      sb.cleanup();
    }
  });

  // Windows: the cli.js path is a NODE argument, so the wrapper bakes the ABSOLUTE node-form path
  // (to_node_path) instead of the runtime `dirname "$0"` POSIX form, which node.exe misreads when
  // Git Bash path translation is off. The sandbox BIN_DIR has no drive prefix, so what's asserted
  // is the baked-absolute shape; the /c→C:/ rewrite itself is pinned in pathLogic.test.ts.
  it("bakes the absolute cli.js path on Windows (no runtime dirname)", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(
        sb,
        `${EXTRACT_AND_INSTALL}\ncreate_wrapper\n[ -x "$BIN_DIR/$APP_BIN" ] && echo EXEC\ncat "$BIN_DIR/$APP_BIN"`,
        { globals: { ...baseGlobals(sb, tarball), OS: "windows", ENTRY_JS: "cli.js" } },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("EXEC");
      expect(r.stdout).toContain(`'${sb.path("app/.ru-code/bin")}/cli.js'`);
      expect(r.stdout).not.toContain("dirname");
    } finally {
      sb.cleanup();
    }
  });
});

describe("install verify", () => {
  it("passes for a cli.js that answers --version", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb);
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `${EXTRACT_AND_INSTALL}\nverify_app && echo VERIFIED`, {
        globals: baseGlobals(sb, tarball),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("VERIFIED");
    } finally {
      sb.cleanup();
    }
  });

  it("dies when cli.js fails to run", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb, { cliVersionExit: 1 });
      sb.write("tmp/.keep", "");
      const r = sourceEval(sb, `${EXTRACT_AND_INSTALL}\nverify_app`, {
        globals: baseGlobals(sb, tarball),
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("Что-то пошло не так");
    } finally {
      sb.cleanup();
    }
  });
});
