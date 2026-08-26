// Standalone install-time preflight entry. Bash runs this with node; it:
//   - resolves OUR_ROOT (where WE install) from home+platform rules — ALWAYS, independent of the
//     CLI engine — then resolves the CLI engine (a dependency) as a separate CHECK,
//   - validates node engine / cli.js / git,
//   - prints a readable report + the mandatory location lines to STDERR,
//   - emits the result as KEY=VALUE lines (incl. CHECK_* facts) on STDOUT for the installer, which
//     owns the per-check fatality policy. A genuinely unexpected error exits non-zero (→ crash).

import { buildCliSpawn } from "@ru-code/qwen/spawn";

import {
  APP_BIN,
  applyCliProbeEnv,
  checkCli,
  checkGit,
  checkNodeEngine,
  collectDiagnostics,
  MESSAGES,
  probeCliIdentity,
  resolveQwenCli,
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

// ru-code: HOW bash must run the CLI bin — derived from the ONE dispatcher (buildCliSpawn), so the
// installer's warm-up and the app can never disagree. Stable values, consumed by 30-core.sh:
// "node" (the historic `$NODE_PATH $NODE_FLAGS <bin>` line) / "cmd" / "direct" (run the bin itself).
const cliSpawnKind = (bin: string): "node" | "cmd" | "direct" => {
  const resolved = buildCliSpawn(bin, []);
  if (resolved.command === "cmd.exe") return "cmd";
  return resolved.command === process.execPath ? "node" : "direct";
};

const main = async (): Promise<void> => {
  // Diagnostics first — so even an early STOP carries the full environment.
  writeInfo("Диагностика:");
  for (const line of collectDiagnostics()) writeInfo(`  ${line}`);

  // The ONE resolver (shared with the running app): app home + CLI profile dir ALWAYS resolve; qwen's
  // cli.js comes from the per-platform config path ("" if not installed). Node check is pure → NODE_OK.
  const resolution = resolveQwenCli({ env: process.env });
  // ru-code: identity lookup (CLI_PASS_IDENTITY) — journaled here once; the value itself reaches
  // the probe env via applyCliProbeEnv below and the warm-up via the CLI_IDENTITY line. Misses
  // never block: they degrade to today's env.
  const identityProbe = probeCliIdentity();
  if (identityProbe.state === "ok")
    writeInfo(`identity        : ${identityProbe.value}  (${identityProbe.path})`);
  else if (identityProbe.state === "file-missing")
    writeWarn(`identity: файл не найден — ${identityProbe.path}`);
  else if (identityProbe.state === "key-missing")
    writeWarn(`identity: значение не извлечено из ${identityProbe.path}`);
  // ru-code: the CLI's environment comes from the ONE branding registry the app's spawns use
  // (buildCliEnv); the probe's children inherit process.env, so it is written there before any
  // check runs — otherwise `cli.js --version` runs without its profile dir and the check fails as
  // a phantom version mismatch.
  applyCliProbeEnv(resolution.configDir);
  const nodeCheck = checkNodeEngine();

  process.stdout.write(`OUR_ROOT=${resolution.ourRoot}\n`);
  process.stdout.write(`APP_BIN=${APP_BIN}\n`);
  process.stdout.write(`NODE_OK=${nodeCheck.ok ? "1" : "0"}\n`);
  process.stdout.write(`CLI_JS=${resolution.cliJs}\n`);
  // ru-code: how bash must run that bin (see cliSpawnKind) + the identity value for the warm-up
  // env. Emitted only when meaningful: kind needs a detected bin, identity needs a value.
  if (resolution.cliDetected)
    process.stdout.write(`CLI_SPAWN_KIND=${cliSpawnKind(resolution.cliJs)}\n`);
  if (identityProbe.state === "ok") process.stdout.write(`CLI_IDENTITY=${identityProbe.value}\n`);
  process.stdout.write(`CONFIG_DIR=${resolution.configDir}\n`);
  process.stdout.write(`CONFIG_DIR_ALT=${resolution.configDirAlt}\n`);
  process.stdout.write(`SOURCE=${resolution.source}\n`);
  // ru-code: shipped-node marker → CLI generation. Informational for the installer (bash resolves
  // its own $NODE_PATH before node can run); the APP reads the same facts via resolveStartupQwenCli.
  process.stdout.write(`NODE_BIN=${resolution.nodeBin}\n`);
  process.stdout.write(`COMPATIBILITY=${resolution.compatibility}\n`);
  if (resolution.legacyRoot) process.stdout.write(`LEGACY_ROOT=${resolution.legacyRoot}\n`);
  writeInfo(`app root        : ${resolution.ourRoot}`);
  writeInfo(`CLI profile dir : ${resolution.configDir}  (создаётся при первом запуске)`);
  if (resolution.nodeBin)
    writeInfo(`node (shipped)  : ${resolution.nodeBin}  [${resolution.compatibility}]`);

  // qwen is a DEPENDENCY. Bin present → version-check (ok / old); bin MISSING → "missing". The bash
  // installer decides whether missing/old blocks (per CLI_FATAL). Skip the probe when node is out of
  // range so the failure reads as "node", not a confusing cli error.
  let cliCheck: CheckResult;
  let cliKind: "ok" | "old" | "broken" | "slow" | "missing";
  if (resolution.cliDetected) {
    writeInfo(`CLI bin (cli.js): ${resolution.cliJs}`);
    if (nodeCheck.ok) {
      const cliResult = await checkCli(resolution.cliJs);
      cliCheck = cliResult;
      cliKind = cliResult.kind;
      // ru-code: the raw CLI output is a diagnostic, never a fact for the installer's policy —
      // it goes to the journal (stderr) only, never into the KEY=VALUE stdout contract.
      if (!cliResult.ok && cliResult.outputTail)
        writeError(`CLI raw output: ${cliResult.outputTail}`);
    } else {
      // Node out of range → the probe never ran; this edge case keeps its pre-existing "old" kind.
      cliCheck = { ok: false, line: "CLI: пропущено — Node.js не соответствует требованиям" };
      cliKind = "old";
    }
  } else {
    writeWarn("CLI bin (cli.js): не найден");
    cliCheck = { ok: false, line: "CLI-движок (qwen) не найден" };
    cliKind = "missing";
  }

  const gitCheck = checkGit();

  const checks: ReadonlyArray<CheckResult> = [nodeCheck, cliCheck, gitCheck];
  for (const check of checks) {
    if (check.ok) writeInfo(check.line);
    else writeError(check.line);
  }

  // ru-code: emit each check's factual ok/fail on STDOUT so the installer can apply its OWN
  // per-check fatality policy (node/git/cli). These are FACTS, not policy — the policy (fatal vs
  // warn-and-continue) lives entirely in the bash `install` script. CHECK_CLI_KIND lets the
  // installer pick cli-install (missing) vs cli-update (old); OUR_ROOT is ALWAYS emitted above.
  process.stdout.write(`CHECK_NODE=${nodeCheck.ok ? "ok" : "fail"}\n`);
  process.stdout.write(`CHECK_CLI=${cliCheck.ok ? "ok" : "fail"}\n`);
  process.stdout.write(`CHECK_GIT=${gitCheck.ok ? "ok" : "fail"}\n`);
  process.stdout.write(`CHECK_CLI_KIND=${cliKind}\n`);
  if (checks.some((check) => !check.ok)) {
    writeError(MESSAGES.FOOTER_FAIL);
    exitFailure();
    return;
  }
};

void main();
