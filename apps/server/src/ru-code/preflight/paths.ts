// Generic, per-platform candidate path patterns. This is the ONE file edited
// per deployment — adding entries is what adapts it to a given environment; the
// resolver itself has zero environment-specific awareness.
//
// Tokens (expanded by node in common.ts, no subprocess):
//   {home}         os.homedir()                 ($HOME / %USERPROFILE%)
//   {appdata}      process.env.APPDATA
//   {localappdata} process.env.LOCALAPPDATA
//
// CLI_DIRNAME is the single source of truth for the CLI config dir name.

import { CLI_DIRNAME } from "@ru-code/branding";

import type { PlatformKey } from "./common/types.ts";

/**
 * WHERE the CLI keeps its config dir — always `{home}/$CLI_DIR`, identical
 * across platforms. First `isDir()` match wins. Any alternative runtime/bin
 * location is NEVER searched here — it is read from the CLI's own `.install-dir`
 * record inside the config dir.
 */
export const CONFIG: Record<PlatformKey, ReadonlyArray<string>> = {
  darwin: [`{home}/${CLI_DIRNAME}`],
  linux: [`{home}/${CLI_DIRNAME}`],
  win32: [`{home}/${CLI_DIRNAME}`],
};

/**
 * FALLBACK bin probe — for CLI installers that drop `cli.js` outside
 * `$CLI_DIR/bin`. OFF in production; enabled via the `TRY_TO_FIND_CLI` env flag
 * for local testing. Each entry is probed for an existing `cli.js`.
 *
 * The `<cli>` segments are placeholders — fill them with your real local test
 * layout. With them unfilled, nothing resolves (so production, where the flag
 * is unset, can only use the two authoritative sources).
 */
export const CLI_BIN_PATHS: Record<PlatformKey, ReadonlyArray<string>> = {
  darwin: [
    // local test: pnpm global qwen-code (stable symlinked path, version-independent)
    "{home}/Library/pnpm/global/5/node_modules/@qwen-code/qwen-code/cli.js",
    "{home}/.npm-global/lib/node_modules/<cli>/cli.js",
    "/opt/homebrew/lib/node_modules/<cli>/cli.js",
  ],
  linux: [
    "{home}/.local/share/pnpm/global/5/node_modules/<cli>/cli.js",
    "/usr/local/lib/node_modules/<cli>/cli.js",
  ],
  win32: ["{appdata}/npm/node_modules/<cli>/cli.js", "{localappdata}/<cli>/cli.js"],
};
