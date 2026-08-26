// ru-code: the configurable per-check fatality policy. A failed check either ABORTS with a
// friendly fix card (when its *_FATAL is true) or WARNS and continues (default for git/cli),
// noting it on the success card. Node is fatal by default (covered in flow.test.ts).

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, runInstaller, writeFakePreflight, writeFakeRelease } from "./harness.ts";

describe("install check policy — warn (default) vs fatal", () => {
  it("git failure WARNS and continues by default (install succeeds, note shown)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, checkGit: "fail" });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(r.all).toContain("установлен ·");
      expect(r.all).toContain("Git"); // ⚠ note about git on the success card
    } finally {
      sb.cleanup();
    }
  });

  it("git failure ABORTS with the git fix card when INSTALL_GIT_FATAL=true", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, checkGit: "fail" });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_GIT_FATAL: "true" } });

      expect(r.status).not.toBe(0);
      expect(r.all).toContain("git-scm.com"); // git fix instruction
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("cli failure WARNS and continues by default", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, checkCli: "fail" });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("cli failure ABORTS with the cli fix card when INSTALL_CLI_FATAL=true", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, checkCli: "fail" });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_CLI_FATAL: "true" } });

      expect(r.status).not.toBe(0);
      expect(r.all).toContain("CLI");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("MISSING CLI engine → cli-install recommendation (blocking under CLI_FATAL), NOT a crash", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "missing",
      });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_CLI_FATAL: "true" } });

      expect(r.status).toBe(1); // BLOCKED_RECOMMENDATION — not crash(2)
      expect(r.all).toContain("CLI-движок не установлен");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("OLD CLI engine → cli-update recommendation", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "old",
      });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_CLI_FATAL: "true" } });

      expect(r.status).toBe(1);
      expect(r.all).toContain("Обновите CLI-движок");
    } finally {
      sb.cleanup();
    }
  });

  it("MISSING CLI engine with CLI_FATAL=false → install proceeds (warn only)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "missing",
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight }); // CLI_FATAL defaults false

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      // not-required + MISSING → skipped entirely (N/A): no cli recommendation at all
      expect(r.all).not.toContain("CLI-движок");
    } finally {
      sb.cleanup();
    }
  });

  it("BROKEN CLI engine → cli-broken recommendation, WARNS by default (install proceeds)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "broken",
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight }); // CLI_FATAL defaults false

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(r.all).toContain("CLI-движок не запускается");
    } finally {
      sb.cleanup();
    }
  });

  it("BROKEN CLI engine → cli-broken recommendation, BLOCKS when INSTALL_CLI_FATAL=true", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "broken",
      });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_CLI_FATAL: "true" } });

      expect(r.status).toBe(1); // BLOCKED_RECOMMENDATION
      expect(r.all).toContain("CLI-движок не запускается");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("SLOW CLI engine → cli-slow recommendation, WARNS by default (install proceeds)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "slow",
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight }); // CLI_FATAL defaults false

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(r.all).toContain("CLI-движок работает слишком медленно");
    } finally {
      sb.cleanup();
    }
  });

  it("SLOW CLI engine → cli-slow recommendation, BLOCKS when INSTALL_CLI_FATAL=true", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        checkCli: "fail",
        checkCliKind: "slow",
      });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight, env: { INSTALL_CLI_FATAL: "true" } });

      expect(r.status).toBe(1); // BLOCKED_RECOMMENDATION
      expect(r.all).toContain("CLI-движок работает слишком медленно");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("node failure can be downgraded to a warning with INSTALL_NODE_FATAL=false", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, nodeOk: "0", status: 1 });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { INSTALL_NODE_FATAL: "false" } });

      expect(r.status).toBe(0); // no longer blocks
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});
