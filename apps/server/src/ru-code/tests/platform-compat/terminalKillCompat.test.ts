// ru-code: pins the Windows-safe kill behaviour (TERMINAL_WINDOWS_KILL_COMPAT). node-pty
// throws on ANY signal argument on Windows, so the compat path must call kill() bare there
// and keep the signal on POSIX; the escalation must not abandon force-kill after a thrown
// graceful kill, and must skip the redundant force step after a successful win32 ConPTY kill.

import { TERMINAL_WINDOWS_KILL_COMPAT } from "@ru-code/platform-compat/constants";
import { describe, expect, it } from "vite-plus/test";

import {
  killPtyProcessCompat,
  shouldForceKillAfterFailedGracefulKill,
  shouldSkipForceKillAfterGracefulKill,
} from "../../platform-compat/terminalKillCompat.ts";

function recordingKill() {
  const calls: Array<string | undefined> = [];
  const kill = (signal?: string) => {
    calls.push(signal);
  };
  return { calls, kill };
}

describe("killPtyProcessCompat", () => {
  it("win32: drops the signal (node-pty throws on any signal argument there)", () => {
    const { calls, kill } = recordingKill();
    killPtyProcessCompat(kill, "SIGTERM", "win32");
    expect(calls).toEqual([TERMINAL_WINDOWS_KILL_COMPAT ? undefined : "SIGTERM"]);
  });

  it("linux/darwin: passes the signal through unchanged", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { calls, kill } = recordingKill();
      killPtyProcessCompat(kill, "SIGKILL", platform);
      expect(calls).toEqual(["SIGKILL"]);
    }
  });
});

describe("kill escalation policy", () => {
  it("a thrown graceful kill still force-kills (upstream silently gave up)", () => {
    expect(shouldForceKillAfterFailedGracefulKill()).toBe(TERMINAL_WINDOWS_KILL_COMPAT);
  });

  it("win32 skips the force step after a successful kill (ConPTY kill is already hard)", () => {
    expect(shouldSkipForceKillAfterGracefulKill("win32")).toBe(TERMINAL_WINDOWS_KILL_COMPAT);
    expect(shouldSkipForceKillAfterGracefulKill("linux")).toBe(false);
    expect(shouldSkipForceKillAfterGracefulKill("darwin")).toBe(false);
  });
});
