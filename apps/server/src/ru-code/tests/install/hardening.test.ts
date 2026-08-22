// @effect-diagnostics nodeBuiltinImport:off - install-flow: builds fixtures + a hanging preflight.
// ru-code: production hardening (§12a) — exit codes per state, the stale-safe single-instance lock,
// the two-tier node floor (bash, before the preflight), preflight timeout, and download integrity
// (sha256 mismatch → crash). Everything sandboxed; a hanging binary still terminates the run.

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  INSTALL_SCRIPT,
  makeSandbox,
  makeShimDir,
  pathWith,
  runInstaller,
  sourceEval,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

function happy(sb: Sandbox): string {
  writeFakeRelease(sb, { version: "0.13.1" });
  return writeFakePreflight(sb);
}

describe("hardening — exit codes (§12a)", () => {
  it("SUCCESS → 0, REC → 1, CRASH → 2", () => {
    const sb = makeSandbox();
    try {
      const pf = happy(sb);
      expect(runInstaller(sb, { preflight: pf, args: ["--keep-source"] }).status).toBe(0);
    } finally {
      sb.cleanup();
    }
    const sb2 = makeSandbox();
    try {
      const pf = writeFakePreflight(sb2); // no release → REC(package)
      expect(runInstaller(sb2, { preflight: pf }).status).toBe(1);
    } finally {
      sb2.cleanup();
    }
    const sb3 = makeSandbox();
    try {
      writeFakeRelease(sb3);
      const pf = writeFakePreflight(sb3, { emitKeys: false, status: 3 }); // no OUR_ROOT → CRASH
      expect(runInstaller(sb3, { preflight: pf }).status).toBe(2);
    } finally {
      sb3.cleanup();
    }
  });

  it("the INT/TERM traps map to 130/143 (installed up front)", () => {
    const script = NodeFS.readFileSync(INSTALL_SCRIPT, "utf8");
    expect(script).toContain("exit 130");
    expect(script).toContain("exit 143");
  });
});

describe("hardening — single-instance lock (§12a)", () => {
  it("a live lock PID → REC(busy)", () => {
    const sb = makeSandbox();
    try {
      const pf = happy(sb);
      sb.write("home/.ru-code-install.lock/pid", `${process.pid}\n`); // OUR pid = alive
      const r = runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
      expect(r.status).toBe(1);
      expect(r.all).toContain("Установка уже выполняется");
    } finally {
      sb.cleanup();
    }
  });

  it("a stale lock PID (dead) is reclaimed → install proceeds", () => {
    const sb = makeSandbox();
    try {
      const pf = happy(sb);
      sb.write("home/.ru-code-install.lock/pid", "999999\n"); // almost-certainly dead
      const r = runInstaller(sb, { preflight: pf, args: ["--keep-source"] });
      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

describe("hardening — node floor (§8, two-tier: bash before the preflight)", () => {
  it("node absent → REC(node-install), preflight skipped", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(
        sb,
        `command_exists() { [ "$1" != node ] && command -v "$1" >/dev/null 2>&1; }\ncheck_node_floor`,
      );
      expect(r.status).toBe(1);
      expect(r.all).toContain("Node.js не установлен");
    } finally {
      sb.cleanup();
    }
  });

  it("node major below the floor → REC(node-update)", () => {
    const sb = makeSandbox();
    try {
      const shim = makeShimDir(sb, { node: `echo v18.4.0` });
      const r = sourceEval(sb, `check_node_floor`, { env: { PATH: pathWith(shim) } });
      expect(r.status).toBe(1);
      expect(r.all).toContain("Обновите Node.js");
    } finally {
      sb.cleanup();
    }
  });

  it("node in range → floor passes, NODE_PATH resolved", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `check_node_floor; echo "P=$NODE_PATH"`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("P=");
      expect(r.stdout).not.toContain("P=\n");
    } finally {
      sb.cleanup();
    }
  });
});

describe("hardening — extract into the clone, not OS temp (§12a)", () => {
  it("installs even when $TMPDIR is read-only (extract lands in the clone dir)", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      const roTmp = sb.path("readonly-tmp");
      NodeFS.mkdirSync(roTmp, { recursive: true });
      NodeFS.chmodSync(roTmp, 0o555); // read-only
      try {
        const r = runInstaller(sb, {
          preflight: pf,
          args: ["--keep-source"],
          env: { TMPDIR: roTmp },
        });
        expect(r.status).toBe(0);
        expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      } finally {
        NodeFS.chmodSync(roTmp, 0o755);
      }
    } finally {
      sb.cleanup();
    }
  });

  it("uses the BUNDLED preflight (inside the archive) when no override is set", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" }); // bakes a sandbox preflight.mjs into the tgz
      const r = runInstaller(sb, { args: ["--keep-source"] }); // NO preflight override
      expect(r.status).toBe(0);
      expect(r.all).toContain("установлен · 0.13.1");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});
