// The per-platform candidate paths for qwen's `cli.js`. This is the ONE file edited per deployment —
// filling in the real bin locations is what adapts the resolver to a given environment; the resolver
// itself has zero environment-specific awareness and probes these in order (first existing wins).
//
// Tokens (expanded by node in expand.ts, no subprocess):
//   {home}         os.homedir()                 ($HOME / %USERPROFILE%)
//   {appdata}      process.env.APPDATA
//   {localappdata} process.env.LOCALAPPDATA

import { PREFLIGHT_CLI_PROBE_DIRNAME } from "@ru-code/branding";

import type { PlatformKey } from "./common/types.ts";

/**
 * WHERE qwen's `cli.js` lives — the ONE and only source the resolver consults. The `<cli>` segments
 * are placeholders: fill them with the real per-deployment layout. With them unfilled nothing
 * resolves, so dev/test stay isolated via the throwaway `$HOME` each test owns. First `isFile()`
 * match wins; `cliDetected` is simply "a match was found".
 */
export const CLI_BIN_PATHS: Record<PlatformKey, ReadonlyArray<string>> = {
  darwin: [
    // local test: pnpm global qwen-code (stable symlinked path, version-independent)
    "{home}/Library/pnpm/global/5/node_modules/@qwen-code/qwen-code/cli.js",
    "{home}/.npm-global/lib/node_modules/<cli>/cli.js",
    "/opt/homebrew/lib/node_modules/<cli>/cli.js",
    // last-resort fallback: the CLI's own config-dir bin (`~/<dir>/bin/cli.js`)
    `{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`,
  ],
  linux: [
    "{home}/.local/share/pnpm/global/5/node_modules/<cli>/cli.js",
    "/usr/local/lib/node_modules/<cli>/cli.js",
    `{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`,
  ],
  win32: [
    "{appdata}/npm/node_modules/<cli>/cli.js",
    "{localappdata}/<cli>/cli.js",
    `{home}/${PREFLIGHT_CLI_PROBE_DIRNAME}/bin/cli.js`,
  ],
};
