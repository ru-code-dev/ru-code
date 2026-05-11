/**
 * Startup-gate preflight Effect.
 *
 * Probes node / git / CLI, aggregates failures, logs each result via
 * `Effect.logInfo` (ok) or `Effect.logError` (miss), and fails with a
 * typed `PreflightFailedError` when any check fails so `Command.run`
 * exits non-zero naturally.
 *
 * Call sites: `runServerCommand` (cli/server.ts) and
 * `runDaemonLauncher` (daemonLauncher.ts), each gated by the
 * `--no-preflight-check` flag.
 *
 * Mirrors install (bash) behaviour. See
 * `ru-fork-instrumental/changes/deamon/startap-checks.md`.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CLI_BINARY_NAME } from "../../config.ts";
import { collectStreamAsString, isCommandMissingCause } from "../../provider/providerSnapshot.ts";
import { resolveSpawn } from "../spawn/policy.ts";
import { CLI_MIN_VERSION, MESSAGES, NODE_ENGINE_RANGE } from "./constants.ts";
import { isAtLeast, parseVersion, satisfiesRange } from "./versionRange.ts";

// Only spawns have timeouts; `checkNode` is pure (reads
// process.versions.node) and doesn't need one.
const GIT_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 15_000;

export class PreflightFailedError extends Data.TaggedError("PreflightFailedError")<{
  readonly failures: ReadonlyArray<string>;
}> {}

type CheckResult =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly line: string };

const render = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? `{${k}}`);

type ProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly reason: "missing" | "broken" | "timeout";
      readonly stderr?: string;
    };

/**
 * Spawns `bin --version` and inspects the outcome. Mirrors the exact
 * pattern in `CliProvider.ts:127-195`: pipe spawn → `Effect.timeoutOption`
 * → `Effect.result`, then branch on the Result/Option shape:
 *   - failure (e.g. ENOENT) → "missing" or "broken" via `isCommandMissingCause`
 *   - None (timeoutOption returned None) → "timeout"
 *   - exitCode !== 0 → "broken"
 *   - else → ok with stdout
 *
 * `shell` mirrors the existing per-tool spawn shapes:
 *   - git:  shell=false (matches `GitVcsDriverCore.ts:642`)
 *   - CLI: shell=process.platform==="win32" (matches `CliProvider.ts:135`)
 */
const probe = (
  bin: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  shell: boolean,
): Effect.Effect<ProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const resolved = resolveSpawn(bin, args, { shell });
    const probeResult = yield* Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(resolved.command, [...resolved.args], {
        shell: resolved.shell,
      });
      const child = yield* spawner.spawn(command);
      // stderr MUST be drained concurrently. A piped child blocks on its
      // next stderr write once the OS pipe buffer fills (small on Windows),
      // and `child.exitCode` never resolves while the process is stuck —
      // surfaces as a `timeout` reason despite the child being moments
      // from exit. Mirrors CliProvider.ts:139-146.
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    }).pipe(Effect.scoped, Effect.timeoutOption(timeoutMs), Effect.result);

    if (Result.isFailure(probeResult)) {
      return isCommandMissingCause(probeResult.failure)
        ? ({ ok: false, reason: "missing" } satisfies ProbeResult)
        : ({ ok: false, reason: "broken" } satisfies ProbeResult);
    }
    if (Option.isNone(probeResult.success)) {
      return { ok: false, reason: "timeout" } satisfies ProbeResult;
    }
    const { stdout, stderr, exitCode } = probeResult.success.value;
    return exitCode === 0
      ? ({ ok: true, stdout } satisfies ProbeResult)
      : ({ ok: false, reason: "broken", stderr } satisfies ProbeResult);
  });

const checkShell = (): Effect.Effect<CheckResult> =>
  Effect.sync(() => {
    // On Windows the only supported launch context is Git Bash. MSYSTEM
    // is set by git-bash (MINGW64/MINGW32/MSYS); cmd / PowerShell /
    // Explorer don't set it. Distinct message from GIT_MISSING so the
    // user understands the issue is the *shell*, not a missing binary.
    if (process.platform !== "win32") return { ok: true, line: "" };
    if (!process.env.MSYSTEM) {
      return { ok: false, line: MESSAGES.GIT_BASH_REQUIRED };
    }
    return { ok: true, line: "" };
  });

const checkNode = (): Effect.Effect<CheckResult> =>
  Effect.sync(() => {
    // The running process is the node we'll use; no spawn needed.
    // Node cannot be "missing" here — if it were, we wouldn't be running.
    const current = `v${process.versions.node}`;
    if (!satisfiesRange(process.versions.node, NODE_ENGINE_RANGE)) {
      return { ok: false, line: render(MESSAGES.NODE_LOW, { found: current }) };
    }
    return { ok: true, line: render(MESSAGES.NODE_OK, { found: current }) };
  });

const appendDetail = (baseLine: string, stderr: string | undefined): string => {
  const detail = stderr?.trim();
  return detail ? `${baseLine}\n  ${detail}` : baseLine;
};

const checkGit = (): Effect.Effect<CheckResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* probe("git", ["--version"], GIT_TIMEOUT_MS, false);
    if (!result.ok) {
      const baseLine = result.reason === "missing" ? MESSAGES.GIT_MISSING : MESSAGES.GIT_BROKEN;
      return { ok: false, line: appendDetail(baseLine, result.stderr) };
    }
    const parsed = parseVersion(result.stdout);
    if (!parsed) return { ok: false, line: MESSAGES.GIT_BROKEN };
    return { ok: true, line: render(MESSAGES.GIT_OK, { found: parsed.join(".") }) };
  });

const checkCli = (): Effect.Effect<CheckResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* probe(
      CLI_BINARY_NAME,
      ["--version"],
      CLI_TIMEOUT_MS,
      process.platform === "win32",
    );
    if (!result.ok) {
      const baseLine = result.reason === "missing" ? MESSAGES.CLI_MISSING : MESSAGES.CLI_BROKEN;
      return { ok: false, line: appendDetail(baseLine, result.stderr) };
    }
    const parsed = parseVersion(result.stdout);
    if (!parsed) return { ok: false, line: MESSAGES.CLI_BROKEN };
    const found = parsed.join(".");
    if (CLI_MIN_VERSION && !isAtLeast(found, CLI_MIN_VERSION)) {
      return { ok: false, line: render(MESSAGES.CLI_LOW, { found }) };
    }
    return { ok: true, line: render(MESSAGES.CLI_OK, { found }) };
  });

/**
 * Run all three checks, log each result line at info (ok) or error
 * (failure) level, fail with `PreflightFailedError` if any failed.
 */
export const runPreflight: Effect.Effect<
  void,
  PreflightFailedError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  yield* Effect.logInfo(MESSAGES.HEADER);
  // `concurrency: "unbounded"` matches the codebase convention
  // (CliProvider.ts:145). checkShell + checkNode are sync and resolve
  // instantly; checkGit and checkCli run in parallel, so worst-case
  // is the CLI probe budget (15 s), not sum-of-budgets.
  const results = yield* Effect.all([checkShell(), checkNode(), checkGit(), checkCli()], {
    concurrency: "unbounded",
  });
  for (const r of results) {
    // Empty line === silent pass (checkShell on non-Windows). Skip.
    if (r.line.length === 0) continue;
    if (r.ok) yield* Effect.logInfo(r.line);
    else yield* Effect.logError(r.line);
  }
  const failureLines = results
    .filter((r) => !r.ok)
    .map((r) => r.line)
    .filter((line) => line.length > 0);
  if (failureLines.length > 0) {
    yield* Effect.logError(MESSAGES.FOOTER_FAIL);
    // PreflightFailedError extends Data.TaggedError which makes it
    // directly yieldable; `return yield* error` signals a definitive
    // exit point so the type narrows correctly past this branch.
    return yield* new PreflightFailedError({ failures: failureLines });
  }
});
