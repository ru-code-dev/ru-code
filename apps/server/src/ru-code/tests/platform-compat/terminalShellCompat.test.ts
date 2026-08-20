// ru-code: pins the Windows shell-candidate policy (TERMINAL_WINDOWS_SHELL) and the widened
// fallback rule (TERMINAL_SHELL_FALLBACK_ANY_ERROR). Ordering assertions are written relative
// to the constants so flipping a constant for a field test doesn't break the suite logic.

import {
  TERMINAL_SHELL_FALLBACK_ANY_ERROR,
  TERMINAL_WINDOWS_SHELL,
} from "@ru-code/platform-compat/constants";
import { describe, expect, it } from "vite-plus/test";

import {
  isRetryableShellSpawnErrorCompat,
  orderWindowsShellCandidatesCompat,
} from "../../platform-compat/terminalShellCompat.ts";

interface TestShellCandidate {
  shell: string;
  args?: string[];
}

const UPSTREAM_CANDIDATES: ReadonlyArray<TestShellCandidate> = [
  { shell: "pwsh.exe", args: ["-NoLogo"] },
  { shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo"] },
  { shell: "powershell.exe", args: ["-NoLogo"] },
  { shell: "C:\\Windows\\System32\\cmd.exe" },
  { shell: "cmd.exe" },
];

const ENV_WITH_GIT: NodeJS.ProcessEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
};

const gitBashAt = (root: string) => `${root}\\Git\\bin\\bash.exe`;

describe("orderWindowsShellCandidatesCompat", () => {
  it("keeps every upstream candidate (no shell is ever LOST by reordering)", () => {
    const ordered = orderWindowsShellCandidatesCompat(
      [...UPSTREAM_CANDIDATES],
      ENV_WITH_GIT,
      () => false,
    );
    for (const candidate of UPSTREAM_CANDIDATES) {
      expect(ordered.map((entry) => entry.shell)).toContain(candidate.shell);
    }
  });

  it("appends existing Git-Bash installs as fallbacks (default mode) / leads with them (git-bash mode)", () => {
    const existing = gitBashAt("C:\\Program Files");
    const ordered = orderWindowsShellCandidatesCompat(
      [...UPSTREAM_CANDIDATES],
      ENV_WITH_GIT,
      (path) => path === existing,
    );
    const gitBashIndex = ordered.findIndex((entry) => entry.shell === existing);
    expect(gitBashIndex).not.toBe(-1);
    expect(ordered[gitBashIndex]?.args).toEqual(["--login", "-i"]);
    if (TERMINAL_WINDOWS_SHELL === "git-bash") {
      expect(gitBashIndex).toBe(0);
    } else if (TERMINAL_WINDOWS_SHELL === "powershell") {
      // Upstream order untouched; git-bash strictly after every upstream candidate.
      expect(ordered.slice(0, UPSTREAM_CANDIDATES.length).map((entry) => entry.shell)).toEqual(
        UPSTREAM_CANDIDATES.map((entry) => entry.shell),
      );
    }
  });

  it("cmd mode puts the cmd family first and keeps PowerShell as fallback", () => {
    if (TERMINAL_WINDOWS_SHELL !== "cmd") {
      return;
    }
    const ordered = orderWindowsShellCandidatesCompat([...UPSTREAM_CANDIDATES], {}, () => false);
    expect(ordered[0]?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(ordered.map((entry) => entry.shell)).toContain("powershell.exe");
  });

  it("a missing Git-Bash install is never offered", () => {
    const ordered = orderWindowsShellCandidatesCompat(
      [...UPSTREAM_CANDIDATES],
      ENV_WITH_GIT,
      () => false,
    );
    expect(ordered.some((entry) => entry.shell.endsWith("bash.exe"))).toBe(false);
  });

  it("a throwing exists-probe is treated as not-installed, never fails candidate building", () => {
    const ordered = orderWindowsShellCandidatesCompat(
      [...UPSTREAM_CANDIDATES],
      ENV_WITH_GIT,
      () => {
        throw new Error("EPERM");
      },
    );
    expect(ordered.length).toBe(UPSTREAM_CANDIDATES.length);
  });
});

describe("isRetryableShellSpawnErrorCompat", () => {
  it("widens (or preserves) the upstream retry decision per the constant", () => {
    // Upstream said retryable ⇒ always retryable.
    expect(isRetryableShellSpawnErrorCompat(true)).toBe(true);
    // Upstream said NOT retryable (e.g. access denied): the flag decides — this is the
    // case where powershell fails on a given setup and cmd.exe must still be attempted.
    expect(isRetryableShellSpawnErrorCompat(false)).toBe(TERMINAL_SHELL_FALLBACK_ANY_ERROR);
  });
});
