// ru-code: Windows terminal shell selection + candidate-fallback policy (seams:
// terminal/Manager.ts resolveShellCandidates + trySpawn retry check).
//
// TERMINAL_WINDOWS_SHELL picks which shell family goes FIRST in the spawn-candidate list
// ("powershell" keeps the upstream order); the other families stay as fallbacks. "git-bash"
// resolves Git-for-Windows bash.exe from its standard install locations — deliberately NOT
// a bare `bash.exe` PATH lookup, which on Windows can hit the System32 WSL launcher.
//
// TERMINAL_SHELL_FALLBACK_ANY_ERROR widens upstream's retry rule: upstream only advances to
// the next candidate on "not found" errors, so any other spawn failure (access-denied / UNKNOWN)
// of candidate #1 aborts the whole start even though candidate #2 would work. With the flag
// on, ANY candidate spawn failure advances; the start fails only after the LAST candidate.

// @effect-diagnostics nodeBuiltinImport:off - resolveShellCandidates is a SYNC pure function
// inside the terminal Manager; the effect FileSystem service cannot reach its call path, and
// this is a trivial install-path existence probe (also injectable for tests).
import * as NodeFS from "node:fs";

import {
  TERMINAL_SHELL_FALLBACK_ANY_ERROR,
  TERMINAL_WINDOWS_SHELL,
} from "@ru-code/platform-compat/constants";

import type { ShellCandidate } from "../../terminal/Manager.ts";

const GIT_BASH_RELATIVE_PATH = "\\Git\\bin\\bash.exe";

function gitBashInstallPaths(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : undefined,
  ];
  return roots
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => `${root.replace(/[\\/]+$/u, "")}${GIT_BASH_RELATIVE_PATH}`);
}

function candidateKey(candidate: ShellCandidate): string {
  return candidate.args && candidate.args.length > 0
    ? `${candidate.shell} ${candidate.args.join(" ")}`
    : candidate.shell;
}

function dedupeCandidates(candidates: ReadonlyArray<ShellCandidate>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

const isCmdCandidate = (candidate: ShellCandidate): boolean =>
  /(^|[\\/])cmd(\.exe)?$/iu.test(candidate.shell);

/**
 * Reorder (and, for git-bash, extend) the upstream-built win32 candidate list according to
 * TERMINAL_WINDOWS_SHELL. Existing Git-Bash installs are appended as last-resort fallbacks in
 * every mode, so a machine where BOTH PowerShell and cmd are denied still gets a shell.
 */
export function orderWindowsShellCandidatesCompat(
  upstreamCandidates: ReadonlyArray<ShellCandidate>,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = NodeFS.existsSync,
): ShellCandidate[] {
  const gitBashCandidates: ShellCandidate[] = gitBashInstallPaths(env)
    .filter((path) => {
      try {
        return fileExists(path);
      } catch {
        return false;
      }
    })
    .map((path) => ({ shell: path, args: ["--login", "-i"] }));

  switch (TERMINAL_WINDOWS_SHELL) {
    case "git-bash":
      return dedupeCandidates([...gitBashCandidates, ...upstreamCandidates]);
    case "cmd": {
      const cmdFirst = upstreamCandidates.filter(isCmdCandidate);
      const rest = upstreamCandidates.filter((candidate) => !isCmdCandidate(candidate));
      return dedupeCandidates([...cmdFirst, ...rest, ...gitBashCandidates]);
    }
    case "powershell":
      return dedupeCandidates([...upstreamCandidates, ...gitBashCandidates]);
  }
}

/** Widened retry rule for candidate iteration (see the module doc). */
export function isRetryableShellSpawnErrorCompat(upstreamSaysRetryable: boolean): boolean {
  return TERMINAL_SHELL_FALLBACK_ANY_ERROR ? true : upstreamSaysRetryable;
}
