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
 * Resolve the startup CLI state in a SINGLE resolver pass — the SAME `resolveQwenCli` the installer
 * preflight uses, so app runtime and install-time detection can never diverge. The resolver never
 * fails: `ourRoot`/`configDir` always resolve; `cliDetected` = qwen's bin was found. Missing qwen ⇒
 * disabled, non-fatal.
 */
export const resolveStartupQwenCli = (options: ResolveOptions = {}): StartupQwenCli => {
  const resolution = resolveQwenCli(options);
  return {
    defaultBaseDir: resolution.ourRoot,
    cliJs: resolution.cliJs,
    cliConfigDir: resolution.configDir,
    cliDetected: resolution.cliDetected,
  };
};
