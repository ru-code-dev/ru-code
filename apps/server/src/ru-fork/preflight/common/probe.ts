// @effect-diagnostics nodeBuiltinImport:off
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// The only subprocess in the resolver: `<command> <args>` with a timeout, used
// for node/git/cli version probes. Distinguishes missing / broken / timeout.

import { spawnSync } from "node:child_process";

import { extractVersion } from "./version.ts";
import type { ProbeResult } from "./types.ts";

export const probeVersion = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): ProbeResult => {
  const probe = spawnSync(command, [...args], {
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
  });

  if (probe.error) {
    const errorCode = (probe.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") return { ok: false, reason: "missing" };
    if (errorCode === "ETIMEDOUT") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "broken" };
  }
  // spawnSync on timeout: status === null with a kill signal set.
  if (probe.status === null && probe.signal) return { ok: false, reason: "timeout" };
  if (probe.status !== 0) return { ok: false, reason: "broken" };

  const combinedOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  const version = extractVersion(combinedOutput);
  return version ? { ok: true, version } : { ok: false, reason: "broken" };
};
