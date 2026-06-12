// Standalone install-time preflight entry. Bash runs this with node; it:
//   - resolves { configDir, cliJs, source, ourRoot } (the state machine),
//   - validates node engine / cli.js / git,
//   - prints a readable report + the three mandatory location lines to STDERR,
//   - on success, emits the result as KEY=VALUE lines on STDOUT for the
//     installer to consume; on any failure or hard crash, exits non-zero so the
//     installer deletes itself.

import {
  APP_BIN,
  checkCli,
  checkGit,
  checkNodeEngine,
  collectDiagnostics,
  MESSAGES,
  resolveCli,
} from "./common/index.ts";
import type { CheckResult } from "./common/index.ts";

// Color the report on stderr (stdout stays clean KEY=VALUE for bash). Only when
// stderr is a TTY, so piping/capture never embeds escape codes.
const ESC = String.fromCharCode(27);
const useColor = process.stderr.isTTY === true;
const paint = (code: string, text: string): string =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

const writeInfo = (line: string): void =>
  void process.stderr.write(`${paint("0;32", "[INFO]")} ${line}\n`);
const writeWarn = (line: string): void =>
  void process.stderr.write(`${paint("0;33", "[WARN]")} ${line}\n`);
const writeError = (line: string): void =>
  void process.stderr.write(`${paint("0;31", "[ERROR]")} ${line}\n`);

const exitFailure = (): never => process.exit(1);

const main = async (): Promise<void> => {
  // Diagnostics first — so even an early STOP carries the full environment.
  writeInfo("Диагностика:");
  for (const line of collectDiagnostics()) writeInfo(`  ${line}`);

  // Enabled by default for local testing; set TRY_TO_FIND_CLI=0 to disable.
  // TODO: flip the default to off before production.
  const tryFindCli = process.env.TRY_TO_FIND_CLI !== "0";

  // STEP 1–3 — resolve config dir, cli.js, our install root.
  const resolution = resolveCli({ tryFindCli });
  if (!resolution.ok) {
    if (resolution.configDir) writeInfo(`CLI config dir : ${resolution.configDir}`);
    writeError(resolution.reason);
    for (const detail of resolution.details) writeError(`  ${detail}`);
    exitFailure();
    return;
  }

  const { configDir, cliJs, source, ourRoot } = resolution;

  // Node check is pure (no spawn) — compute it now so NODE_OK can be emitted
  // up front. It gates whether the installer runs the old app's `stop`.
  const nodeCheck = checkNodeEngine();

  // Emit the resolved result on STDOUT *before* the cli/git checks, so the
  // installer still receives OUR_ROOT/APP_BIN/NODE_OK (for clean-up) even if a
  // check below fails. APP_BIN carries the command name so bash never hardcodes
  // branding.
  process.stdout.write(`OUR_ROOT=${ourRoot}\n`);
  process.stdout.write(`APP_BIN=${APP_BIN}\n`);
  process.stdout.write(`NODE_OK=${nodeCheck.ok ? "1" : "0"}\n`);
  process.stdout.write(`CLI_JS=${cliJs}\n`);
  process.stdout.write(`CONFIG_DIR=${configDir}\n`);
  process.stdout.write(`SOURCE=${source}\n`);
  if (resolution.legacyRoot) process.stdout.write(`LEGACY_ROOT=${resolution.legacyRoot}\n`);

  // Mandatory location log lines (every successful resolution, all platforms).
  writeInfo(`CLI config dir : ${configDir}`);
  if (source === "fallback") writeWarn(`cli.js в АЛЬТЕРНАТИВНОМ пути: ${cliJs}`);
  writeInfo(`CLI bin (cli.js): ${cliJs}  [source: ${source}]`);
  writeInfo(`app root        : ${ourRoot}`);
  resolution.warnings?.forEach(writeWarn);

  // STEP 4–6 — dependency checks. Skip the cli probe if node is out of range so
  // the failure reads as "node", not a confusing cli error. (nodeCheck computed
  // above for NODE_OK.)
  const cliCheck: CheckResult = nodeCheck.ok
    ? await checkCli(cliJs)
    : { ok: false, line: "CLI: пропущено — Node.js не соответствует требованиям" };
  const gitCheck = checkGit();

  const checks: ReadonlyArray<CheckResult> = [nodeCheck, cliCheck, gitCheck];
  for (const check of checks) {
    if (check.ok) writeInfo(check.line);
    else writeError(check.line);
  }
  if (checks.some((check) => !check.ok)) {
    // OUR_ROOT was already emitted above, so the installer can still clean up.
    writeError(MESSAGES.FOOTER_FAIL);
    exitFailure();
    return;
  }
};

void main();
