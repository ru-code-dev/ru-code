// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// oxlint-disable t3code/namespace-node-imports -- vendored standalone preflight subsystem; keeps its self-contained node-builtin imports
// Preflight is deliberately Effect-free + node-builtins-only so it bundles into
// one standalone file (dist/preflight.mjs) that runs before any deps exist.
//
// The only subprocess in the resolver: `<command> <args>` with a timeout, used
// for node/git/cli version probes. Distinguishes missing / broken / timeout.

import { spawn, spawnSync } from "node:child_process";

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

// ru-code: measure PROCESS-EXIT time (the "exit" event), NOT pipe close. A child
// that exits but whose stdout is held open (AV / daemon) still resolves here
// fast; only a process genuinely slow to exit trips the timeout.
export const probeVersionByExit = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    try {
      const c = spawn(command, [...args], { windowsHide: true });
      child = c;
      c.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      c.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      c.on("error", (error: NodeJS.ErrnoException) => {
        finish({ ok: false, reason: error.code === "ENOENT" ? "missing" : "broken" });
      });
      c.on("exit", (status: number | null) => {
        if (status !== 0) {
          finish({ ok: false, reason: "broken" });
          return;
        }
        const version = extractVersion(`${stdout}${stderr}`);
        finish(version ? { ok: true, version } : { ok: false, reason: "broken" });
      });
    } catch {
      finish({ ok: false, reason: "broken" });
    }
  });
