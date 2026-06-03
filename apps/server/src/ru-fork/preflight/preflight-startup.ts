/**
 * Startup preflight — the launch-time twin of the installer preflight.
 *
 * Runs the SAME shared resolver + checks as `preflight-install.ts` (the `common/`
 * core), so install-time and launch-time agree on cli.js / config dir / app root.
 * This is the whole point of the design: one deterministic resolver, run by the
 * installer AND the app, so the two never diverge (see
 * `ru-fork-instrumental/changes/common-preflight.md`).
 *
 * Two entry points, because the daemon launcher runs the checks in the PARENT
 * and spawns the child with `--no-preflight-check`:
 *
 *   - {@link resolveStartupCli}  — ALWAYS run. Resolves cli.js / config dir /
 *     app root via the §10 state machine. The app cannot function without a
 *     cli.js, so a failed resolution STOPs startup with a readable Russian
 *     report (exactly like the installer) and a `PreflightFailedError`. Its
 *     result is threaded into ServerConfig (base dir, CLI config dir) and the
 *     direct-node CLI spawn (cli.js path).
 *
 *   - {@link runStartupChecks}  — gated by `--no-preflight-check`. node engine +
 *     git + `node cli.js --version`, identical to the installer's steps 4-6.
 *
 * No shell / Git-Bash / terminal check: the CLI is spawned via `node cli.js`
 * directly (never bash / cmd / PowerShell), so the launch shell is irrelevant.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  type CliSource,
  checkGit,
  checkCli,
  checkNodeEngine,
  collectDiagnostics,
  MESSAGES,
  resolveCli,
} from "./common/index.ts";

export class PreflightFailedError extends Data.TaggedError("PreflightFailedError")<{
  readonly failures: ReadonlyArray<string>;
}> {}

export interface PreflightResolution {
  readonly cliJs: string;
  readonly configDir: string;
  readonly ourRoot: string;
  readonly source: CliSource;
}

// On in production (the placeholder bin paths resolve nothing, so it's inert);
// a real local path under CLI_BIN_PATHS makes dev resolution work. Off only when
// explicitly set to "0".
const tryFindCliEnabled = (): boolean => process.env.TRY_TO_FIND_CLI !== "0";

/**
 * Resolve cli.js / config dir / app root. Always runs (the daemon child skips
 * the version checks but still needs these paths). STOPs on a failed resolution.
 */
export const resolveStartupCli: Effect.Effect<PreflightResolution, PreflightFailedError> =
  Effect.gen(function* () {
    // Diagnostics first so even an immediate STOP carries the full environment.
    for (const line of collectDiagnostics()) yield* Effect.logInfo(line);

    const resolution = resolveCli({ tryFindCli: tryFindCliEnabled() });
    if (!resolution.ok) {
      yield* Effect.logError(resolution.reason);
      for (const detail of resolution.details) yield* Effect.logError(`  ${detail}`);
      yield* Effect.logError(MESSAGES.FOOTER_FAIL);
      return yield* new PreflightFailedError({
        failures: [resolution.reason, ...resolution.details],
      });
    }

    // The three lines support reads to know everything (mirrors install §10).
    yield* Effect.logInfo(`CLI config dir  : ${resolution.configDir}`);
    yield* Effect.logInfo(`CLI bin (cli.js): ${resolution.cliJs}  [source: ${resolution.source}]`);
    yield* Effect.logInfo(`app root        : ${resolution.ourRoot}`);

    return {
      cliJs: resolution.cliJs,
      configDir: resolution.configDir,
      ourRoot: resolution.ourRoot,
      source: resolution.source,
    };
  });

/**
 * node engine + git + `node cli.js --version`. Gated by `--no-preflight-check`.
 * Aggregates failures and STOPs with a `PreflightFailedError` if any check fails
 * — identical behaviour to the installer's aggregated steps 4-6.
 *
 * The probes are synchronous (`spawnSync` via the shared `probe.ts`); acceptable
 * here because this runs once at startup, before the server begins serving.
 */
export const runStartupChecks = (cliJs: string): Effect.Effect<void, PreflightFailedError> =>
  Effect.gen(function* () {
    const results = [checkNodeEngine(), checkGit(), checkCli(cliJs)];
    for (const result of results) {
      if (result.ok) yield* Effect.logInfo(result.line);
      else yield* Effect.logError(result.line);
    }
    const failures = results.filter((result) => !result.ok).map((result) => result.line);
    if (failures.length > 0) {
      yield* Effect.logError(MESSAGES.FOOTER_FAIL);
      return yield* new PreflightFailedError({ failures });
    }
  });
