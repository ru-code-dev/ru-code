// @effect-diagnostics nodeBuiltinImport:off
//
// The resolution state machine. Pure (no logging, no exit) so it is reusable
// and testable; the caller owns reporting. Mirrors
// ru-fork-instrumental/changes/common-preflight.md §10.
//
// OUR_ROOT is exec-capable by deduction: cli.js only resolves at a location the
// CLI installer already proved executable (it stays in {home} only when that
// passed, otherwise it records the exec location in .install-dir). So there is
// no exec re-test here.

import * as os from "node:os";
import * as path from "node:path";

import { CLI_BIN_PATHS, CONFIG } from "../paths.ts";
import { APP_DIR, CLI_DIR } from "./constants.ts";
import { expand } from "./expand.ts";
import { isDir, isFile, readInstallRecord } from "./fs.ts";
import { MESSAGES } from "./messages.ts";
import type { CliResolution, PlatformKey, ResolveOptions } from "./types.ts";

const toPlatformKey = (platform: NodeJS.Platform): PlatformKey =>
  platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux";

/**
 * Step 3 → FALLBACK: probe CLI_BIN_PATHS. Returns the resolved cli.js, or the
 * list of probed paths (when nothing matched) so the caller can STOP + report.
 */
const tryFallbackBinPaths = (
  platformKey: PlatformKey,
  env: NodeJS.ProcessEnv,
  tryFindCli: boolean,
): { readonly cliJs: string } | { readonly stop: ReadonlyArray<string> } => {
  if (!tryFindCli) return { stop: ["TRY_TO_FIND_CLI выключен"] };
  const patterns = CLI_BIN_PATHS[platformKey] ?? [];
  if (patterns.length === 0) return { stop: ["CLI_BIN_PATHS пуст"] };

  const probedPaths: string[] = [];
  for (const pattern of patterns) {
    const candidate = expand(pattern, env);
    probedPaths.push(candidate);
    if (isFile(candidate)) return { cliJs: candidate };
  }
  return { stop: probedPaths };
};

export const resolveCli = (options: ResolveOptions = {}): CliResolution => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const tryFindCli = options.tryFindCli ?? false;
  const platformKey = toPlatformKey(platform);

  // STEP 1 — find the config dir.
  const checkedConfigPaths: string[] = [];
  let configDir: string | undefined;
  for (const pattern of CONFIG[platformKey] ?? []) {
    const candidate = expand(pattern, env);
    checkedConfigPaths.push(candidate);
    if (isDir(candidate)) {
      configDir = candidate;
      break;
    }
  }
  if (!configDir) {
    return { ok: false, reason: MESSAGES.CONFIG_NOT_FOUND, details: checkedConfigPaths };
  }

  // STEP 2 — gather the two authoritative sources.
  const homeBinCli = path.join(configDir, "bin", "cli.js");
  const recordedBinDir = readInstallRecord(configDir);
  const recordedCli = recordedBinDir ? path.join(recordedBinDir, "cli.js") : "";

  // STEP 3 + 4 — resolve cli.js, derive OUR_ROOT (exec-capable by deduction).
  const resolveStandard = (): CliResolution => ({
    ok: true,
    configDir,
    cliJs: homeBinCli,
    source: "standard",
    ourRoot: path.join(path.dirname(configDir), APP_DIR),
  });

  const resolveFromInstallRecord = (): CliResolution => ({
    ok: true,
    configDir,
    cliJs: recordedCli,
    source: "install-dir",
    ourRoot: path.join(path.dirname(path.dirname(recordedBinDir)), APP_DIR),
  });

  const resolveFromFallback = (): CliResolution => {
    const fallback = tryFallbackBinPaths(platformKey, env, tryFindCli);
    if ("cliJs" in fallback) {
      return {
        ok: true,
        configDir,
        cliJs: fallback.cliJs,
        source: "fallback",
        ourRoot: path.join(os.homedir(), APP_DIR),
      };
    }
    return { ok: false, reason: MESSAGES.CLI_NOT_FOUND, details: fallback.stop, configDir };
  };

  // A = home bin exists → standard (must agree with .install-dir if present).
  if (isFile(homeBinCli)) {
    if (recordedCli && path.normalize(recordedCli) !== path.normalize(homeBinCli)) {
      return {
        ok: false,
        reason: MESSAGES.SOURCES_DISAGREE,
        details: [`bin: ${homeBinCli}`, `.install-dir: ${recordedCli}`],
        configDir,
      };
    }
    return resolveStandard();
  }

  // A absent, .install-dir present → trust it only with the standard layout.
  if (recordedBinDir) {
    if (!isFile(recordedCli)) {
      return {
        ok: false,
        reason: MESSAGES.INSTALL_DIR_NOWHERE,
        details: [`.install-dir → ${recordedBinDir}`],
        configDir,
      };
    }
    const looksLikeStandardLayout =
      path.basename(recordedBinDir) === "bin" &&
      path.basename(path.dirname(recordedBinDir)) === CLI_DIR;
    return looksLikeStandardLayout ? resolveFromInstallRecord() : resolveFromFallback();
  }

  // A absent, no .install-dir → fallback (or STOP).
  return resolveFromFallback();
};
