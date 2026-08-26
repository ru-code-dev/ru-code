// Dependency checks: node engine / git / cli.js. Each returns a CheckResult
// with a ready-to-print line.

import { cliArgAssignments, cliEnvAssignments } from "@ru-code/branding";
import { buildCliSpawn } from "@ru-code/qwen/spawn";

import {
  CLI_MIN_VERSION,
  CLI_PROBE_TIMEOUT_MS,
  GIT_PROBE_TIMEOUT_MS,
  NODE_ENGINE_RANGE,
} from "./constants.ts";
import { identityEnvRuntime } from "./identity.ts";
import { MESSAGES } from "./messages.ts";
import { probeVersion, probeVersionByExit } from "./probe.ts";
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

/**
 * ru-code: hand the CLI its environment before any probe runs.
 *
 * The probe below spawns the CLI as a CHILD, which inherits `process.env` — so the branding CLI
 * registry (@ru-code/branding cliEnv.ts) is written there, exactly as the running app writes it
 * onto every spawn. Without the profile dir the probe runs against the wrong home and the check
 * reads as a phantom version mismatch. An empty resolved dir writes nothing (the CLI then falls
 * back to its own default) rather than exporting a blank variable.
 *
 * Lives here, beside the probe that depends on it, so it is reachable from a test — the preflight
 * entry module runs `main()` on import and cannot be imported by one.
 */
export const applyCliProbeEnv = (configDir: string, env: NodeJS.ProcessEnv = process.env): void => {
  const home = configDir.trim();
  if (home.length === 0) return;
  // ru-code: the identity value rides along exactly as it does on the app's spawns (buildCliEnv):
  // supplied when the identity file yields one, the variable omitted entirely otherwise.
  for (const [name, value] of cliEnvAssignments({ HOME: home, ...identityEnvRuntime() }))
    env[name] = value;
};

/** The CLI check's classification — the KIND behind its CheckResult, exposed so the caller
 * (preflight.ts) can pick the right recommendation without re-deriving it from `line`. */
export type CliCheckKind = "ok" | "old" | "broken" | "slow";

export type CliCheckResult = CheckResult & {
  readonly kind: CliCheckKind;
  /** Combined stdout+stderr from a FAILED probe (broken/slow only) — a diagnostic passthrough of
   * the underlying ProbeResult's `outputTail`, absent when there was none. Never printed to stdout;
   * the caller (preflight.ts) logs it to stderr only. */
  readonly outputTail?: string;
};

/** Probe the resolved CLI bin, invoked the same way the app spawns it (the ONE dispatcher —
 * buildCliSpawn): a `.js` bin runs on the running node interpreter exactly as before. */
export const checkCli = async (cliJs: string): Promise<CliCheckResult> => {
  // ru-code: the registry's shared flags ride along — a version probe is never an MCP client, and
  // without the allowlist flag the CLI connects and awaits every configured server first.
  const resolved = buildCliSpawn(cliJs, ["--version", ...cliArgAssignments()]);
  const cliProbe = await probeVersionByExit(
    resolved.command,
    [...resolved.args],
    CLI_PROBE_TIMEOUT_MS,
  );
  if (cliProbe.ok) {
    if (CLI_MIN_VERSION && !isAtLeast(cliProbe.version, CLI_MIN_VERSION)) {
      return {
        ok: false,
        kind: "old",
        line: render(MESSAGES.CLI_LOW, { found: cliProbe.version }),
      };
    }
    return { ok: true, kind: "ok", line: render(MESSAGES.CLI_OK, { found: cliProbe.version }) };
  }
  if (cliProbe.reason !== "timeout") {
    // ru-code: exactOptionalPropertyTypes — spread-when-present, never an explicit `undefined`.
    return {
      ok: false,
      kind: "broken",
      line: MESSAGES.CLI_BROKEN,
      ...(cliProbe.outputTail !== undefined ? { outputTail: cliProbe.outputTail } : {}),
    };
  }
  // ru-code: timeout = the process is too slow to EXIT. Held-pipe machines exit
  // fast (probeVersionByExit measures the "exit" event) and pass; only genuinely
  // slow-to-exit hardware reaches here. Gate the app off it.
  return { ok: false, kind: "slow", line: MESSAGES.CLI_TOO_SLOW };
};
