// @effect-diagnostics nodeBuiltinImport:off - install-flow test drives the real bash installer.
//
// ru-code: the SOURCED launcher (USE_RC_SOURCED_LAUNCHER) wired through the REAL install flow —
// full `bash install` runs, not the isolated functions. The white-box laws live in
// rcSourcedLaunch.test.ts; this suite proves the end-to-end contract:
//
//   · ON  install: <bin>/env.sh written; every rc gets ONE guarded source line; the command
//     resolves AS A FUNCTION in a fresh shell that reads nothing but the rc file
//   · OFF install (the shipped default): byte-behaviour of today — export line, NO env.sh
//   · switch flips ACROSS installs converge in one run, both directions (the scrub is
//     generation-blind), and uninstall cleans up whichever generation is on disk
//   · a read-only rc stays non-fatal in ON mode, same as the classic contract
//
// The switch rides the documented env override (INSTALL_USE_RC_SOURCED_LAUNCHER), same mechanism
// tests and power users get for every other installer toggle.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

const ON = { env: { INSTALL_USE_RC_SOURCED_LAUNCHER: "true" } };
const KEEP = ["--keep-source"] as const;

/** Replace the single co-located bundle with one at `version` (single-bundle contract). */
function swapBundle(sb: Sandbox, version: string): void {
  for (const f of NodeFS.readdirSync(sb.distBundleDir)) {
    if (f.endsWith(".tgz")) NodeFS.rmSync(sb.path("ru-code/dist-bundle", f), { force: true });
  }
  writeFakeRelease(sb, { version });
}

const countMarkerLines = (rc: string): number =>
  rc.split("\n").filter((line) => line.includes(".ru-code/bin")).length;

/** Fresh bash that reads NOTHING but the sandbox .bashrc, then reports on the command. */
function probeShell(sb: Sandbox, script: string): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync(
    "bash",
    ["--norc", "--noprofile", "-c", `. "$HOME/.bashrc" >/dev/null 2>&1; ${script}`],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sb.home, TERM: "dumb" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

describe("sourced launcher through the real install flow", () => {
  it("ON: env.sh + ONE guarded line per rc; the command is a FUNCTION in a fresh shell", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\nalias ll='ls -la'\n");

      const r = runInstaller(sb, { preflight: pf, args: [...KEEP], ...ON });
      expect(r.status, r.all).toBe(0);

      // env.sh landed inside bin, with the function and baked paths.
      expect(sb.exists("app/.ru-code/bin/env.sh")).toBe(true);
      const envSh = sb.read("app/.ru-code/bin/env.sh");
      expect(envSh).toContain("ru-code() {");
      expect(envSh).toContain(`'${sb.path("app/.ru-code/bin")}/cli.js'`);

      // Every rc target: exactly ONE marker line, the guarded source shape, no classic export.
      const guarded = `[ -f "${sb.path("app/.ru-code/bin")}/env.sh" ] && . "${sb.path("app/.ru-code/bin")}/env.sh"`;
      for (const rc of ["home/.bashrc", "home/.profile", "home/.zshrc"]) {
        const content = sb.read(rc);
        expect(content, `${rc} must carry the guarded line`).toContain(guarded);
        expect(countMarkerLines(content), `${rc} must carry exactly one line of ours`).toBe(1);
        expect(content, `${rc} must not carry the classic export`).not.toContain('export PATH="');
      }
      expect(sb.read("home/.bashrc")).toContain("alias ll='ls -la'");

      // A fresh shell that reads only the rc resolves the command AS A FUNCTION.
      const probe = probeShell(sb, `LC_ALL=C type ru-code | head -n 1`);
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout).toContain("function");
    } finally {
      sb.cleanup();
    }
  });

  it("OFF (shipped default): classic export line, NO env.sh — today's behaviour, byte-verifiable", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight: pf, args: [...KEEP] }); // no switch env — the default
      expect(r.status, r.all).toBe(0);

      expect(sb.exists("app/.ru-code/bin/env.sh"), "OFF must not create env.sh").toBe(false);
      const rc = sb.read("home/.bashrc");
      expect(rc).toContain(`export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`);
      expect(rc).not.toContain("env.sh");
      expect(countMarkerLines(rc)).toBe(1);
    } finally {
      sb.cleanup();
    }
  });

  it("switch OFF→ON across an update: the classic line converges to the guarded line in ONE run", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n");

      expect(runInstaller(sb, { preflight: pf, args: [...KEEP] }).status).toBe(0); // OFF
      expect(sb.read("home/.bashrc")).toContain('export PATH="');

      swapBundle(sb, "0.14.0");
      const second = runInstaller(sb, { preflight: pf, args: [...KEEP], ...ON });
      expect(second.status, second.all).toBe(0);

      const rc = sb.read("home/.bashrc");
      expect(rc).not.toContain('export PATH="');
      expect(rc).toContain(`&& . "${sb.path("app/.ru-code/bin")}/env.sh"`);
      expect(countMarkerLines(rc)).toBe(1);
      expect(sb.exists("app/.ru-code/bin/env.sh")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("switch ON→OFF across an update: the guarded line converges back to the classic line", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n");

      expect(runInstaller(sb, { preflight: pf, args: [...KEEP], ...ON }).status).toBe(0);
      expect(sb.read("home/.bashrc")).toContain("env.sh");

      swapBundle(sb, "0.14.0");
      const second = runInstaller(sb, { preflight: pf, args: [...KEEP] }); // OFF again
      expect(second.status, second.all).toBe(0);

      const rc = sb.read("home/.bashrc");
      expect(rc).toContain(`export PATH="${sb.path("app/.ru-code/bin")}:$PATH"`);
      expect(rc).not.toContain("env.sh");
      expect(countMarkerLines(rc)).toBe(1);
      // The old bin (and its env.sh) were replaced; OFF does not re-create the file.
      expect(sb.exists("app/.ru-code/bin/env.sh")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("uninstall after an ON install: rc scrubbed, bin (and env.sh with it) gone", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# keep me\n");

      expect(runInstaller(sb, { preflight: pf, args: [...KEEP], ...ON }).status).toBe(0);
      const r = runInstaller(sb, { preflight: pf, args: ["--uninstall", ...KEEP] });
      expect(r.status, r.all).toBe(0);

      expect(sb.exists("app/.ru-code/bin")).toBe(false);
      for (const rc of ["home/.bashrc", "home/.profile", "home/.zshrc"]) {
        expect(sb.read(rc), `${rc} must be fully scrubbed`).not.toContain(".ru-code/bin");
      }
      expect(sb.read("home/.bashrc")).toContain("# keep me");
    } finally {
      sb.cleanup();
    }
  });

  it("ON with a read-only .bashrc: non-fatal, the guarded line lands in a writable fallback", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      sb.write("home/.bashrc", "# shell\n", 0o444);

      const r = runInstaller(sb, { preflight: pf, args: [...KEEP], ...ON });

      expect(r.status, r.all).toBe(0); // never fatal
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin");
      expect(sb.read("home/.profile")).toContain(`&& . "${sb.path("app/.ru-code/bin")}/env.sh"`);
    } finally {
      sb.cleanup();
    }
  });
});
