// @effect-diagnostics nodeBuiltinImport:off - install-flow: drives the real bash installer, reads rc.
// ru-code: rc handling WIRED INTO THE REAL FLOW (not just the isolated clean_rc/add_path units).
// Two regressions this locks:
//   (a) a read-only shell rc is NON-FATAL — `add_path` can't write, `note path` records a ⚠ on the
//       card, and the install still succeeds (exit 0). Before `note` was defined, `note path` hit an
//       undefined command → `set -e` crash (127) → rollback of the freshly-installed app.
//   (b) an UPDATE leaves EXACTLY ONE PATH line — phase_commit runs `clean_rc` before `add_path`, so a
//       re-install/update strips the prior line before re-adding (add_path only appends).

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

const KEEP = { args: ["--keep-source"] as const };

/** Replace the single co-located bundle with one at `version` (single-bundle contract). */
function swapBundle(sb: Sandbox, version: string): void {
  for (const f of NodeFS.readdirSync(sb.distBundleDir)) {
    if (f.endsWith(".tgz")) NodeFS.rmSync(sb.path("ru-code/dist-bundle", f), { force: true });
  }
  writeFakeRelease(sb, { version });
}

const countPathLines = (rc: string): number =>
  rc.split("\n").filter((line) => line.includes(".ru-code/bin")).length;

describe("install rc handling (real flow)", () => {
  it("read-only .bashrc → install SUCCEEDS (exit 0), PATH persists to a writable fallback", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      // .bashrc exists but is read-only. A single unwritable rc no longer blocks PATH — add_path
      // still creates .profile/.zshrc, so the install succeeds AND PATH is actually set.
      sb.write("home/.bashrc", "# shell\n", 0o444);

      const r = runInstaller(sb, { preflight: pf, ...KEEP });

      expect(r.status).toBe(0); // non-fatal — NOT the 127→crash(2) the missing `note` guarded
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true); // app installed, never rolled back
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin"); // read-only rc never written
      expect(sb.read("home/.profile")).toContain(".ru-code/bin"); // login-file fallback carries it
    } finally {
      sb.cleanup();
    }
  });

  it("install then UPDATE → exactly ONE .ru-code/bin PATH line (clean_rc wired before add_path)", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n");

      const first = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(first.status).toBe(0);
      expect(countPathLines(sb.read("home/.bashrc"))).toBe(1); // one after install

      swapBundle(sb, "0.14.0");
      const second = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(second.status).toBe(0);
      expect(second.all).toContain("обновлён · 0.13.1 → 0.14.0");
      // STILL exactly one — the update scrubbed the prior line before re-adding (no accumulation)
      expect(countPathLines(sb.read("home/.bashrc"))).toBe(1);
    } finally {
      sb.cleanup();
    }
  });

  it("re-install (same bundle overwrite) also leaves exactly ONE PATH line", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n");

      runInstaller(sb, { preflight: pf, ...KEEP });
      // force a re-install path: break the installed --version so decide_action overwrites
      sb.write(
        "app/.ru-code/bin/cli.js",
        `if(process.argv[2]==="--version")process.exit(1);process.exit(0);`,
      );
      const r = runInstaller(sb, { preflight: pf, ...KEEP });

      expect(r.status).toBe(0);
      expect(countPathLines(sb.read("home/.bashrc"))).toBe(1);
    } finally {
      sb.cleanup();
    }
  });
});
