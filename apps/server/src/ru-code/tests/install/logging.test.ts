// ru-code: logging + screen-cleanliness contract. Everything (OS diagnostics, every step,
// subprocess noise) goes to $HOME/.ru-code-install.log; the screen shows only distilled cards.
// The log survives rollback (it lives outside the app dir) and is copied into the app dir on
// success. An unexpected failure shows the support ask; the screen carries no raw ANSI on a
// non-TTY run.

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  readLog,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
} from "./harness.ts";

describe("install logging", () => {
  it("writes a diagnostics-rich log at $HOME and copies it into the app dir on success", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      const log = readLog(sb);
      expect(log).toContain("os:"); // OS diagnostics line
      expect(log).toContain("pwd:");
      expect(log).toContain("Установка"); // internal step detail landed in the log, not on screen
      expect(sb.exists("app/.ru-code/install.log")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("keeps the log intact through a rollback (verify failure)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb, { cliVersionExit: 1 });
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(2); // BLOCKED_CRASH (verify failure + rollback)
      expect(sb.exists("app/.ru-code/bin")).toBe(false); // rolled back
      const log = readLog(sb);
      expect(log).not.toBe(""); // preserved
      expect(log).toContain("install"); // journal header survives the rollback
    } finally {
      sb.cleanup();
    }
  });

  it("shows the support ask + log path on an unexpected crash (no OUR_ROOT)", () => {
    const sb = makeSandbox();
    try {
      // preflight emits nothing and errors → no OUR_ROOT → CRASH with the support ask
      const preflight = writeFakePreflight(sb, { emitKeys: false, status: 3 });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(2);
      expect(r.all).toContain("поддержку");
      expect(r.all).toContain("Журнал");
    } finally {
      sb.cleanup();
    }
  });

  it("captures the preflight's own stderr report into the journal (2>/dev/null removed)", () => {
    const sb = makeSandbox();
    try {
      const marker = "[preflight] report-marker-xyz\n";
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, report: marker });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      const log = readLog(sb);
      expect(log).toContain("report-marker-xyz");
    } finally {
      sb.cleanup();
    }
  });

  it("emits no raw ANSI to the screen on a non-TTY run", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(r.all.includes("[")).toBe(false); // color-free when stdout isn't a terminal
    } finally {
      sb.cleanup();
    }
  });
});
