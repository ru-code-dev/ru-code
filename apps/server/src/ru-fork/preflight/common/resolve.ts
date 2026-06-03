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
import { APP_DIR, CLI_DIR, LINUX_SAFE_DIR } from "./constants.ts";
import { expand } from "./expand.ts";
import { isDir, isFile, readInstallRecord } from "./fs.ts";
import { MESSAGES } from "./messages.ts";
import type { CliResolution, PlatformKey, ResolveOptions } from "./types.ts";

const toPlatformKey = (platform: NodeJS.Platform): PlatformKey =>
  platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux";

// Linux OUR_ROOT placement. When /home/<LINUX_SAFE_DIR>/<user> exists, the app
// root goes there; otherwise it stays in the home dir. <user> = the real account
// name (os.userInfo) — matches /home/work/<user> even when the home FOLDER name
// differs from the username. Pure: returns paths only; the installer deletes the
// orphaned home copy reported as legacyRoot.
const linuxRoots = (): { readonly ourRoot: string; readonly legacyRoot?: string } => {
  const homeRoot = path.join(os.homedir(), APP_DIR);
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    // No passwd entry (rare) — stay in home.
  }
  if (!username) return { ourRoot: homeRoot };
  const preferredDir = path.join("/home", LINUX_SAFE_DIR, username);
  if (!isDir(preferredDir)) return { ourRoot: homeRoot };
  return { ourRoot: path.join(preferredDir, APP_DIR), legacyRoot: homeRoot };
};

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

  // Linux overrides OUR_ROOT via the preferred-dir rule; mac/Windows keep the
  // per-source derivation. pickRoot applies that override only on Linux.
  const roots = platformKey === "linux" ? linuxRoots() : null;
  const pickRoot = (nonLinux: string): string => (roots ? roots.ourRoot : nonLinux);
  const legacyRoot = roots?.legacyRoot;

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
    ourRoot: pickRoot(path.join(path.dirname(configDir), APP_DIR)),
    ...(legacyRoot ? { legacyRoot } : {}),
  });

  const resolveFromInstallRecord = (): CliResolution => ({
    ok: true,
    configDir,
    cliJs: recordedCli,
    source: "install-dir",
    ourRoot: pickRoot(path.join(path.dirname(path.dirname(recordedBinDir)), APP_DIR)),
    ...(legacyRoot ? { legacyRoot } : {}),
  });

  const resolveFromFallback = (): CliResolution => {
    const fallback = tryFallbackBinPaths(platformKey, env, tryFindCli);
    if ("cliJs" in fallback) {
      return {
        ok: true,
        configDir,
        cliJs: fallback.cliJs,
        source: "fallback",
        ourRoot: pickRoot(path.join(os.homedir(), APP_DIR)),
        ...(legacyRoot ? { legacyRoot } : {}),
      };
    }
    return { ok: false, reason: MESSAGES.CLI_NOT_FOUND, details: fallback.stop, configDir };
  };

  // TRY_TO_FIND_CLI = "use my local CLI". When on and CLI_BIN_PATHS has a live
  // cli.js, it IS the primary and WINS unconditionally. We report the state of
  // both primary candidates (home bin + .install-dir) so support sees what was
  // bypassed; none of it STOPs. Flag off / no backup → fall through below.
  if (tryFindCli) {
    const probed = tryFallbackBinPaths(platformKey, env, true);
    if ("cliJs" in probed) {
      const warnings: string[] = [MESSAGES.USING_BACKUP_PRIORITY];
      if (isFile(homeBinCli)) warnings.push(`основной CLI (home): ${homeBinCli} — live`);
      warnings.push(
        recordedBinDir
          ? `.install-dir → ${recordedBinDir} — cli.js ${isFile(recordedCli) ? "live" : "ОТСУТСТВУЕТ (dead)"}`
          : ".install-dir отсутствует",
      );
      warnings.push(`резервный CLI: ${probed.cliJs}`);
      return {
        ok: true,
        configDir,
        cliJs: probed.cliJs,
        source: "fallback",
        ourRoot: pickRoot(path.join(os.homedir(), APP_DIR)),
        ...(legacyRoot ? { legacyRoot } : {}),
        warnings,
      };
    }
    // no backup found → fall through to authoritative resolution unchanged
  }

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
