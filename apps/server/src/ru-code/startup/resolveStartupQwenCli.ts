// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- reuses the standalone preflight resolver; keeps its node-builtin imports
//
// ru-code: the ONE startup CLI resolution. Runs the preflight resolver
// (resolveQwenCli — scans the disk for the qwen cli.js / config dir) EXACTLY
// ONCE at boot and derives everything the server needs from the single result:
//
//   • defaultBaseDir — the resolver's ourRoot (installed app folder,
//     bin/Linux-relocation aware); `--base-dir` / T3CODE_HOME / bootstrap still
//     override it in cli/config.ts. Falls back to `~/.<app>` pre-install.
//   • cliJs / cliConfigDir / cliDetected — threaded into ServerConfig and fed to
//     the qwen provider (profileResolver fills each profile's `null` bin/dir
//     default with these). Detected ⇒ qwen enabled; missed ⇒ qwen disabled,
//     non-fatal, home-dir config fallback.
//
// Both consumers read one CliResolution, so the (potentially slow) disk scan
// never runs twice.

import * as os from "node:os";
import * as path from "node:path";

import { APP_HOME_DIRNAME, PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

import { resolveQwenCli } from "../preflight/common/resolve.ts";
import type { ResolveOptions } from "../preflight/common/types.ts";

export interface StartupQwenCli {
  /** Default base dir: resolver ourRoot when located, else `~/.<app>`. */
  readonly defaultBaseDir: string;
  /** Resolved cli.js (`node <cliJs> --acp`); "" when not detected. */
  readonly cliJs: string;
  /** CLI config dir (`~/.qwen`); home fallback when not detected. */
  readonly cliConfigDir: string;
  /** True ⇒ enable the qwen provider; false ⇒ qwen disabled (non-fatal). */
  readonly cliDetected: boolean;
}

/**
 * Resolve the startup CLI state in a SINGLE preflight pass. Accepts the same
 * options as {@link resolveQwenCli} so it stays injectable for tests; production
 * enables the CLI_BIN_PATHS fallback search unless `TRY_TO_FIND_CLI=0` (the
 * detection contract — placeholder bin paths resolve nothing in prod, so it's
 * inert there but required for a real fork install to be found).
 */
export const resolveStartupQwenCli = (options: ResolveOptions = {}): StartupQwenCli => {
  const env = options.env ?? process.env;
  const tryFindCli = options.tryFindCli ?? env.TRY_TO_FIND_CLI !== "0";
  const resolution = resolveQwenCli({ ...options, env, tryFindCli });
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (resolution.ok) {
    return {
      defaultBaseDir: resolution.ourRoot,
      cliJs: resolution.cliJs,
      cliConfigDir: resolution.configDir,
      cliDetected: true,
    };
  }
  return {
    defaultBaseDir: path.join(home, APP_HOME_DIRNAME),
    cliJs: "",
    cliConfigDir: resolution.configDir ?? path.join(home, PREFLIGHT_CLI_PROBE_DIRNAME),
    cliDetected: false,
  };
};
