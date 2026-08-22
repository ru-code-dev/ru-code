// @effect-diagnostics nodeBuiltinImport:off - install-flow: swaps sandbox bundle tarballs on disk.
// ru-code: update-flow (§2, §9) — version-check drives install / update / already-installed;
// deferred removal keeps a working app intact until COMMIT; confirmed stop checks the exit code;
// a failed update reports the HONEST header («не обновлён · осталась версия X»). All sandboxed.

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  runInstaller,
  sourceEval,
  waitForFile,
  writeFakePreflight,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

const KEEP = { args: ["--keep-source"] as const };

/** Replace the single co-located bundle with one at `version` (single-bundle contract). */
function swapBundle(sb: Sandbox, version: string, opts?: { missingPart?: string }): void {
  for (const f of NodeFS.readdirSync(sb.distBundleDir)) {
    if (f.endsWith(".tgz")) NodeFS.rmSync(sb.path("ru-code/dist-bundle", f), { force: true });
  }
  writeFakeRelease(sb, {
    version,
    ...(opts?.missingPart ? { missingPart: opts.missingPart } : {}),
  });
}

/** Overwrite the INSTALLED bin's cli.js so its --version / stop behave as a scenario needs. */
function patchInstalledCli(sb: Sandbox, body: string): void {
  sb.write("app/.ru-code/bin/cli.js", body);
}

describe("install update-flow", () => {
  // ru-code: regression — the real app CLI (Effect) prints `<name> v<version>` for --version, so
  // read_installed_version MUST extract the bare semver. Before the fix it did `tr -d ' \t\r'`,
  // leaving "ru-codev1.1.2" ≠ the bundle "1.1.2" → EVERY run falsely read as an update.
  it("read_installed_version extracts the bare semver from Effect's `<name> v<version>` output", () => {
    const sb = makeSandbox();
    try {
      // installed cli prints the REAL format, incl. a pre-release suffix (hardest case).
      sb.write(
        "app/.ru-code/bin/cli.js",
        `if(process.argv[2]==="--version"){process.stdout.write("ru-code v2.3.4-rc.1\\n");process.exit(0)}process.exit(0);`,
      );
      const r = sourceEval(
        sb,
        `read_installed_version; echo "V=$INSTALLED_VERSION W=$WAS_INSTALLED"`,
        {
          globals: {
            BIN_DIR: sb.path("app/.ru-code/bin"),
            NODE_PATH: process.execPath,
            NODE_FLAGS: "",
          },
        },
      );
      expect(r.stdout).toContain("V=2.3.4-rc.1 W=1");
    } finally {
      sb.cleanup();
    }
  });

  it("same version → ALREADY_INSTALLED, no re-copy (exit 0)", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      expect(runInstaller(sb, { preflight: pf, ...KEEP }).status).toBe(0);
      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(0);
      expect(r.all).toContain("уже установлен · 0.13.1");
    } finally {
      sb.cleanup();
    }
  });

  it("different version → update, header shows «обновлён · <new>»", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      swapBundle(sb, "0.14.0");
      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(0);
      expect(r.all).toContain("обновлён · 0.13.1 → 0.14.0"); // before → after
      expect(sb.read("app/.ru-code/bin/versions/0.14.0/package.json")).toContain("0.14.0");
      expect(JSON.parse(sb.read("app/.ru-code/bin/current.json")).version).toBe("0.14.0");
      expect(sb.exists("app/.ru-code/bin/versions/0.13.1")).toBe(false); // wiped, not accumulated
    } finally {
      sb.cleanup();
    }
  });

  it("broken existing install (--version fails) → overwrite install (exit 0)", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      patchInstalledCli(sb, `if(process.argv[2]==="--version")process.exit(1);process.exit(0);`);
      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(0);
      expect(r.all).toContain("установлен · 0.13.1"); // fresh-install verb, not "обновлён"
    } finally {
      sb.cleanup();
    }
  });

  it("stop that does NOT confirm dead → REC(stop-failed), old app intact, «не обновлён»", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      // installed app: --version=0.13.1, but `stop` SURVIVES (exit 1)
      patchInstalledCli(
        sb,
        `const a=process.argv[2];if(a==="--version"){process.stdout.write("0.13.1\\n");process.exit(0)}if(a==="stop"){process.exit(1)}process.exit(0);`,
      );
      swapBundle(sb, "0.14.0");
      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(1); // BLOCKED_RECOMMENDATION
      expect(r.all).toContain("Не удалось остановить приложение");
      expect(r.all).toContain("не обновлён · осталась версия 0.13.1"); // honest header
      expect(JSON.parse(sb.read("app/.ru-code/bin/current.json")).version).toBe("0.13.1"); // untouched
    } finally {
      sb.cleanup();
    }
  });

  it("update with RESTART_AFTER_UPDATE relaunches the new app", () => {
    const sb = makeSandbox();
    try {
      const marker = sb.path("relaunched.txt");
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      swapBundle(sb, "0.14.0");
      const r = runInstaller(sb, {
        preflight: pf,
        args: ["--keep-source"],
        env: { INSTALL_RESTART_AFTER_UPDATE: "true", RU_CODE_TEST_MARKER: marker },
      });
      expect(r.status).toBe(0);
      expect(waitForFile(sb, "relaunched.txt")).toBe(true);
      // §3.4 — the installer ALWAYS launches WITH the browser, including this relaunch. The old
      // `--no-browser` branch keyed off WAS_RUNNING, which only means «`stop` returned 0», and the
      // daemon returns 0 when nothing was running — so it silently suppressed the tab for users who
      // had none. Accepted cost: updating with a tab already open yields a second one. (The IN-APP
      // update path still passes --no-browser; that one really does know a tab exists.)
      expect(sb.read("relaunched.txt")).toContain("--json");
      expect(sb.read("relaunched.txt")).not.toContain("--no-browser");
    } finally {
      sb.cleanup();
    }
  });

  it("truncated/corrupt TAR fails before the action is known → «установка не завершена», old app intact", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      // replace the bundle with a NON-tarball (garbage) → extract_archive fails in `prepare`
      for (const f of NodeFS.readdirSync(sb.distBundleDir)) {
        if (f.endsWith(".tgz")) NodeFS.rmSync(sb.path("ru-code/dist-bundle", f), { force: true });
      }
      NodeFS.writeFileSync(
        sb.path("ru-code/dist-bundle/ru-code-0.14.0.tgz"),
        "not a real tarball\n",
      );

      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(2); // CRASH(corrupt)
      expect(r.all).toContain("Пакет повреждён");
      expect(r.all).toContain("установка не завершена"); // NOT a false «не установлен»
      expect(r.all).not.toContain("не установлен"); // the old app is untouched — don't lie
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true); // old app intact
    } finally {
      sb.cleanup();
    }
  });

  it("corrupt NEW bundle fails in PREPARE (before COMMIT) → old app intact (deferred removal)", () => {
    const sb = makeSandbox();
    try {
      writeFakeRelease(sb, { version: "0.13.1" });
      const pf = writeFakePreflight(sb);
      runInstaller(sb, { preflight: pf, ...KEEP });
      swapBundle(sb, "0.14.0", { missingPart: "node_modules" });
      const r = runInstaller(sb, { preflight: pf, ...KEEP });
      expect(r.status).toBe(2); // CRASH(corrupt)
      expect(r.all).toContain("не обновлён · осталась версия 0.13.1");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true); // old app NOT removed
      expect(JSON.parse(sb.read("app/.ru-code/bin/current.json")).version).toBe("0.13.1");
    } finally {
      sb.cleanup();
    }
  });
});
