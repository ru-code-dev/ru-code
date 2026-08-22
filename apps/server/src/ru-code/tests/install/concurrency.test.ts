// @effect-diagnostics nodeBuiltinImport:off - install-flow: drives the real bash installer on disk.
// ru-code: SINGLE-INSTANCE guarantees. The documented invocation is
//   git clone <repo> ru-code && cat ru-code/install | bash
// so two runs started from the same directory share ONE clone dir — which is also SOURCE_DIR, the
// tree the running installer extracts into and copies FROM. A run that loses the single-instance
// lock must therefore leave that directory completely alone: the winner is still reading it.
//
// These specs pin the ownership rule (only the run that HOLDS the lock may delete the clone dir)
// rather than the code shape, so they keep their meaning if the lock implementation changes.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

/**
 * Take the installer's single-instance lock on behalf of a "run already in progress".
 *
 * The lock is `mkdir $HOME/.<slug>-install.lock` + a `pid` file, and the holder is considered
 * alive when `kill -0 <pid>` succeeds. This test process is trivially alive and is never signalled
 * by the installer (`acquire_lock` only probes), so its pid is the cheapest honest stand-in for a
 * concurrent run — and it removes all timing from the spec.
 */
function seedLiveLock(sandbox: Sandbox): string {
  const lockDir = NodePath.join(sandbox.home, ".ru-code-install.lock");
  NodeFS.mkdirSync(lockDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(lockDir, "pid"), `${process.pid}\n`);
  return lockDir;
}

describe("install single-instance lock — the loser must not touch the winner's clone dir", () => {
  it("a busy-rejected install leaves the shared clone dir (and its bundle) untouched", () => {
    const sb = makeSandbox();
    try {
      const tarball = writeFakeRelease(sb, { version: "1.0.0" });
      const preflight = writeFakePreflight(sb);
      seedLiveLock(sb);

      const r = runInstaller(sb, { preflight });

      // Rejected, with the documented card.
      expect(r.status).toBe(1);
      expect(r.all).toContain("Установка уже выполняется");

      // THE POINT: the winner is mid-copy out of this tree. Deleting it destroys that run.
      expect(NodeFS.existsSync(sb.cloneDir)).toBe(true);
      expect(NodeFS.existsSync(tarball)).toBe(true);
      // Nothing was installed either — the rejection is total.
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("after the lock is released the same clone dir still installs — the rejection cost nothing", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "1.0.0" });
      const preflight = writeFakePreflight(sb);
      const lockDir = seedLiveLock(sb);

      expect(runInstaller(sb, { preflight }).status).toBe(1);

      NodeFS.rmSync(lockDir, { recursive: true, force: true }); // the winner finished
      const second = runInstaller(sb, { preflight });

      expect(second.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("uninstall is single-instance too: it is rejected while a run holds the lock, and removes nothing", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "1.0.0" });
      const preflight = writeFakePreflight(sb);

      // A real installed tree for the uninstall to find (and, without the lock, to destroy).
      expect(runInstaller(sb, { preflight, args: ["--keep-source"] }).status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);

      seedLiveLock(sb);
      const r = runInstaller(sb, { preflight, args: ["--uninstall"] });

      expect(r.status).toBe(1);
      expect(r.all).toContain("Установка уже выполняется");
      // The concurrent install's target survives, and so does the clone dir it is reading.
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(NodeFS.existsSync(sb.cloneDir)).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("a stale lock (dead pid) is reclaimed — a killed installer never blocks the next run", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "1.0.0" });
      const preflight = writeFakePreflight(sb);

      const lockDir = NodePath.join(sb.home, ".ru-code-install.lock");
      NodeFS.mkdirSync(lockDir, { recursive: true });
      // A provably dead pid: run a process to completion, then reuse its id. Literal values are not
      // usable here — 0 and negative ids mean "process group" to kill(2), so `kill -0 0` SUCCEEDS
      // and would read as a live holder.
      const dead = NodeChildProcess.spawnSync("true");
      NodeFS.writeFileSync(NodePath.join(lockDir, "pid"), `${dead.pid}\n`);

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});
