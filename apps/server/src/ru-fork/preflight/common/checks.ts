// Dependency checks: node engine / git / cli.js. Each returns a CheckResult
// with a ready-to-print line.

import {
  CLI_MIN_VERSION,
  CLI_PROBE_TIMEOUT_MS,
  GIT_PROBE_TIMEOUT_MS,
  NODE_ENGINE_RANGE,
} from "./constants.ts";
import { MESSAGES } from "./messages.ts";
import { probeVersion } from "./probe.ts";
import { render } from "./render.ts";
import type { CheckResult } from "./types.ts";
import { isAtLeast, satisfiesRange } from "./version.ts";

/** Node cannot be "missing" here — we are running on it. Validate the engine
 * range against the process's own version. */
export const checkNodeEngine = (): CheckResult => {
  const found = `v${process.versions.node}`;
  if (!satisfiesRange(process.versions.node, NODE_ENGINE_RANGE)) {
    return { ok: false, line: render(MESSAGES.NODE_LOW, { found }) };
  }
  return { ok: true, line: render(MESSAGES.NODE_OK, { found }) };
};

export const checkGit = (): CheckResult => {
  const gitProbe = probeVersion("git", ["--version"], GIT_PROBE_TIMEOUT_MS);
  if (!gitProbe.ok) {
    return {
      ok: false,
      line: gitProbe.reason === "missing" ? MESSAGES.GIT_MISSING : MESSAGES.GIT_BROKEN,
    };
  }
  return { ok: true, line: render(MESSAGES.GIT_OK, { found: gitProbe.version }) };
};

/** Probe the resolved cli.js directly with the running node interpreter. */
export const checkCli = (cliJs: string): CheckResult => {
  const cliProbe = probeVersion(process.execPath, [cliJs, "--version"], CLI_PROBE_TIMEOUT_MS);
  if (!cliProbe.ok) return { ok: false, line: MESSAGES.CLI_BROKEN };
  if (CLI_MIN_VERSION && !isAtLeast(cliProbe.version, CLI_MIN_VERSION)) {
    return { ok: false, line: render(MESSAGES.CLI_LOW, { found: cliProbe.version }) };
  }
  return { ok: true, line: render(MESSAGES.CLI_OK, { found: cliProbe.version }) };
};
