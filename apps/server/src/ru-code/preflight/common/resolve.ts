// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- standalone preflight bundle; self-contained node-builtin imports
// oxlint-disable t3code/no-global-process-runtime -- standalone install-time preflight runs before node_modules exist; no Effect runtime to inject
//
// The ONE CLI resolver — shared by the installer preflight AND the running app (resolveStartupQwenCli).
// It answers everything from a single, deterministic rule (no `.install-dir` records, no config-dir
// existence gate, no heuristics):
//
//   • home     = os.homedir() — the ONE home source. expand()'s {home} token uses os.homedir() too,
//                so the parent and the cli.js probe can never desync (e.g. on Windows where
//                %HOME% ≠ %USERPROFILE%). NEVER read env.HOME / env.USERPROFILE for the parent.
//   • ourRoot  = <appParent>/${APP_DIR}   (where WE install). appParent = home, or on Linux the
//                user-profile dir /home/${LINUX_SAFE_DIR}/<user> when it exists.
//   • configDir= <cliParent>/${CLI_DIR}   (qwen's profile dir — NEED NOT EXIST; qwen creates it on
//                first chat). cliParent = home, UNLESS LINUX_USE_SAFE_DIR_FOR_CLI && relocated.
//   • configDirAlt = the relocated /home/<safe>/<user>/${CLI_DIR} on Linux relocation, else "" —
//                the OTHER candidate the installer warm-up checks for where the profile landed.
//   • cliJs    = the qwen bin, found by probing the per-platform config paths (CLI_BIN_PATHS, filled
//                per deployment); "" when qwen isn't installed.
//
// Never fails: ourRoot/configDir always resolve; a missing qwen is just `cliDetected: false`.

import * as os from "node:os";
import * as path from "node:path";

import { NODE_BIN_PATHS } from "@ru-code/branding";

import { CLI_BIN_PATHS } from "../paths.ts";
import { APP_DIR, CLI_DIR, LINUX_SAFE_DIR, LINUX_USE_SAFE_DIR_FOR_CLI } from "./constants.ts";
import { expand } from "./expand.ts";
import { isDir, isFile } from "./fs.ts";
import type { CliResolution, PlatformKey, ResolveOptions } from "./types.ts";

export const toPlatformKey = (platform: NodeJS.Platform): PlatformKey =>
  platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux";

/**
 * The parents for the app home and the CLI profile.
 *   • appParent — home on mac/Windows; on Linux the /home/${LINUX_SAFE_DIR}/<user> user-profile dir
 *     when it exists (else home). <user> = the real account name (os.userInfo), matching
 *     /home/${LINUX_SAFE_DIR}/<user> even when the home FOLDER name differs.
 *   • cliParent — home, UNLESS the app relocated AND LINUX_USE_SAFE_DIR_FOR_CLI (default false, so the
 *     CLI profile stays under home even when the app root relocates — the pre-existing behavior).
 *   • reloc    — the relocated dir itself (only set on a Linux relocation), so the caller can derive
 *     configDirAlt and legacyRoot. HARD RULE: home is os.homedir(), NEVER env.HOME/env.USERPROFILE.
 */
const resolveParents = (
  platformKey: PlatformKey,
): { readonly appParent: string; readonly cliParent: string; readonly reloc?: string } => {
  const home = os.homedir();
  if (platformKey !== "linux") return { appParent: home, cliParent: home };
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    // No passwd entry (rare) — stay in home.
  }
  if (username) {
    const preferred = path.join("/home", LINUX_SAFE_DIR, username);
    if (isDir(preferred)) {
      return {
        appParent: preferred,
        cliParent: LINUX_USE_SAFE_DIR_FOR_CLI ? preferred : home,
        reloc: preferred,
      };
    }
  }
  return { appParent: home, cliParent: home };
};

/**
 * qwen's cli.js = the first EXISTING file among the per-platform config paths (CLI_BIN_PATHS — the ONE
 * source of the bin location, filled per deployment). "" when qwen isn't installed anywhere probed.
 */
const resolveCliJs = (platformKey: PlatformKey, env: NodeJS.ProcessEnv): string => {
  for (const pattern of CLI_BIN_PATHS[platformKey] ?? []) {
    const candidate = expand(pattern, env);
    if (isFile(candidate)) return candidate;
  }
  return "";
};

/**
 * The CLI-SHIPPED node runtime, when its fixed per-platform path (NODE_BIN_PATHS) exists — the ng
 * generation marker. `""` per platform disables the probe; a missing file just means "v1".
 */
const resolveNodeBin = (platformKey: PlatformKey, env: NodeJS.ProcessEnv): string => {
  const pattern = NODE_BIN_PATHS[platformKey];
  if (!pattern) return "";
  const candidate = expand(pattern, env);
  return isFile(candidate) ? candidate : "";
};

export const resolveQwenCli = (options: ResolveOptions = {}): CliResolution => {
  const platformKey = toPlatformKey(options.platform ?? process.platform);
  const env = options.env ?? process.env;
  const parents = resolveParents(platformKey);
  const cliJs = resolveCliJs(platformKey, env);
  const nodeBin = resolveNodeBin(platformKey, env);
  return {
    ourRoot: path.join(parents.appParent, APP_DIR),
    configDir: path.join(parents.cliParent, CLI_DIR),
    configDirAlt: parents.reloc ? path.join(parents.reloc, CLI_DIR) : "",
    cliJs,
    cliDetected: cliJs !== "",
    source: cliJs !== "" ? "config-path" : "none",
    nodeBin,
    // ru-code: shipped node present ⇔ ng CLI ⇒ v2 dispatch (plain model ids, no --auth-type).
    compatibility: nodeBin !== "" ? "v2" : "v1",
    ...(parents.reloc ? { legacyRoot: path.join(os.homedir(), APP_DIR) } : {}),
  };
};
